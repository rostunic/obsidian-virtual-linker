import { App, getAllTags, parseFrontMatterAliases, TFile, Vault } from 'obsidian';

import { LinkerPluginSettings } from 'main';
import { LinkerMetaInfoFetcher } from './linkerInfo';

export class ExternalUpdateManager {
    registeredCallbacks: Set<Function> = new Set();

    constructor() { }

    registerCallback(callback: Function) {
        this.registeredCallbacks.add(callback);
    }

    update() {
        // Timeout to make sure the cache is updated
        setTimeout(() => {
            for (const callback of this.registeredCallbacks) {
                callback();
            }
        }, 50);
    }
}

export class PrefixNode {
    parent: PrefixNode | undefined;
    children: Map<string, PrefixNode> = new Map();
    files: Set<TFile> = new Set();
    charValue: string = '';
    value: string = '';
    requiresCaseMatch: boolean = false;
}

export class VisitedPrefixNode {
    node: PrefixNode;
    caseIsMatched: boolean;
    startedAtWordBeginning: boolean;
    formattingDelta: number = 0;
    constructor(node: PrefixNode, caseIsMatched: boolean = true, startedAtWordBeginning: boolean = false) {
        this.node = node;
        this.caseIsMatched = caseIsMatched;
        this.startedAtWordBeginning = startedAtWordBeginning;
    }
}

export class MatchNode {
    start: number = 0;
    length: number = 0;
    files: Set<TFile> = new Set();
    value: string = '';
    isAlias: boolean = false;
    caseIsMatched: boolean = true;
    startsAtWordBoundary: boolean = false;
    requiresCaseMatch: boolean = false;

    get end(): number {
        return this.start + this.length;
    }
}

export class PrefixTree {
    root: PrefixNode = new PrefixNode();
    fetcher: LinkerMetaInfoFetcher;

    _currentNodes: VisitedPrefixNode[] = [];

    setIndexedFilePaths: Set<string> = new Set();
    mapIndexedFilePathsToUpdateTime: Map<string, number> = new Map();
    mapFilePathToLeaveNodes: Map<string, PrefixNode[]> = new Map();

    constructor(public app: App, public settings: LinkerPluginSettings) {
        this.fetcher = new LinkerMetaInfoFetcher(this.app, this.settings);
        this.updateTree();
    }

    clear() {
        this.root = new PrefixNode();
        this._currentNodes = [];
        this.setIndexedFilePaths.clear();
        this.mapIndexedFilePathsToUpdateTime.clear();
        this.mapFilePathToLeaveNodes.clear();
    }

    getCurrentMatchNodes(index: number, excludedNote?: TFile | null): MatchNode[] {
        const matchNodes: MatchNode[] = [];

        if (excludedNote === undefined && this.settings.excludeLinksToOwnNote) {
            excludedNote = this.app.workspace.getActiveFile();
        }

        // From the current nodes in the trie, get all nodes that have files
        for (const node of this._currentNodes) {
            if (node.node.files.size === 0) {
                continue;
            }
            const matchNode = new MatchNode();
            matchNode.length = node.node.value.length + node.formattingDelta;
            matchNode.start = index - matchNode.length;
            matchNode.files = new Set(Array.from(node.node.files).filter((file) => !excludedNote || file.path !== excludedNote.path));
            matchNode.value = node.node.value;
            matchNode.requiresCaseMatch = node.node.requiresCaseMatch;

            const fileNames = Array.from(matchNode.files).map((file) => file.basename);
            const nodeValue = node.node.value;
            matchNode.isAlias = !fileNames.map((n) => n.toLowerCase()).includes(nodeValue.toLowerCase());

            // Check if the case is matched
            let currentNode: PrefixNode | undefined = node.node;
            while (currentNode) {
                if (!node.caseIsMatched) {
                    matchNode.caseIsMatched = false;
                    break;
                }
                currentNode = currentNode.parent;
            }

            // Check if the match starts at a word boundary
            matchNode.startsAtWordBoundary = node.startedAtWordBeginning;

            if (matchNode.requiresCaseMatch && !matchNode.caseIsMatched) {
                continue;
            }

            if (matchNode.files.size > 0) {
                matchNodes.push(matchNode);
            }
        }

        // Sort nodes by length
        matchNodes.sort((a, b) => b.length - a.length);

        return matchNodes;
    }

    private addFileWithName(name: string, file: TFile, matchCase: boolean) {
        let node = this.root;

        // For each character in the name, add a node to the trie
        for (let char of name) {
            // char = char.toLowerCase();
            let child = node.children.get(char);
            if (!child) {
                child = new PrefixNode();
                child.parent = node;
                child.charValue = char;
                child.value = node.value + char;
                node.children.set(char, child);
            }
            node = child;
        }

        // The last node is a leaf node, add the file to the node
        node.files.add(file);
        node.requiresCaseMatch = matchCase;

        // Store the leaf node for the file to be able to remove it later
        const path = file.path;
        this.mapFilePathToLeaveNodes.set(path, [node, ...(this.mapFilePathToLeaveNodes.get(path) ?? [])]);
        // console.log("Adding file", file, name);
    }

    private static isNoneEmptyString(value: string | null | undefined): value is string {
        return value !== null && value !== undefined && typeof value === 'string' && value.trim().length > 0;
    }

    private static isUpperCaseString(value: string | null | undefined, upperCasePart = 0.75) {
        if (!PrefixTree.isNoneEmptyString(value)) {
            return false;
        }

        const length = value.length;
        const upperCaseChars = value.split('').filter((char) => char === char.toUpperCase()).length;

        return upperCaseChars / length >= upperCasePart;
    }

    private addFileToTree(file: TFile) {
        const path = file.path;

        if (!file || !path) {
            return;
        }

        // Remove the old nodes of the file
        this.removeFileFromTree(file);

        // Add the file to the set of indexed files
        this.setIndexedFilePaths.add(path);
        this.mapIndexedFilePathsToUpdateTime.set(path, file.stat.mtime);

        // Get the virtual linker related metadata of the file
        const metaInfo = this.fetcher.getMetaInfo(file);

        // Get the tags of the file
        // and normalize them by removing the # in front of tags
        const tags = (getAllTags(this.app.metadataCache.getFileCache(file)!!) ?? [])
            .filter(PrefixTree.isNoneEmptyString)
            .map((tag) => (tag.startsWith('#') ? tag.slice(1) : tag));

        const includeFile = metaInfo.includeFile;
        const excludeFile = metaInfo.excludeFile;

        const isInIncludedDir = metaInfo.isInIncludedDir;
        const isInExcludedDir = metaInfo.isInExcludedDir;

        // console.log({
        //     file: file.path,
        //     tags: tags,
        //     includeFile,
        //     excludeFile,
        //     isInIncludedDir,
        //     isInExcludedDir,
        //     includeAllFiles: metaInfo.includeAllFiles
        // });

        if (excludeFile || (isInExcludedDir && !includeFile)) {
            return;
        }

        // Skip files that are not in the linker directories
        if (!includeFile && !isInIncludedDir && !metaInfo.includeAllFiles) {
            return;
        }

        const metadata = this.app.metadataCache.getFileCache(file);
        let aliases: string[] = metadata?.frontmatter?.aliases ?? [];

        let aliasesWithMatchCase: Set<string> = new Set(metadata?.frontmatter?.[this.settings.propertyNameToMatchCase] ?? []);
        let aliasesWithIgnoreCase: Set<string> = new Set(metadata?.frontmatter?.[this.settings.propertyNameToIgnoreCase] ?? []);
        let excludedAliases: Set<string> = new Set(metadata?.frontmatter?.[this.settings.propertyNameToExcludeTexts] ?? []);

        // if (aliasesWithMatchCase.size > 0 || aliasesWithIgnoreCase.size > 0) {
        //     console.log("Aliases with match case", aliasesWithMatchCase, file.basename);
        //     console.log("Aliases with ignore case", aliasesWithIgnoreCase, file.basename);
        //     console.log("Excluded aliases", excludedAliases, file.basename);
        // }

        // If aliases is not an array, convert it to an array
        if (!Array.isArray(aliases)) {
            aliases = [aliases];
        }

        // Filter out empty aliases
        try {
            aliases = aliases.filter(PrefixTree.isNoneEmptyString);
        } catch (e) {
            console.error('[VL LC] Error filtering aliases', aliases, e);
        }

        let names = [file.basename];
        if (aliases && this.settings.includeAliases) {
            names.push(...aliases);
        }

        names = names.filter(PrefixTree.isNoneEmptyString);
        names = names.filter((name) => !excludedAliases.has(name));

        let namesWithCaseIgnore = new Array<string>();
        let namesWithCaseMatch = new Array<string>();

        // Check if the file should match case sensitive
        if (this.settings.matchCaseSensitive) {
            let lowerCaseNames = new Array<string>();
            if (tags.includes(this.settings.tagToIgnoreCase)) {
                namesWithCaseIgnore = [...names];
            } else {
                namesWithCaseMatch = [...names];
            }
            lowerCaseNames = lowerCaseNames.map((name) => name.toLowerCase());
            names.push(...lowerCaseNames);
        } else {
            let lowerCaseNames = new Array<string>();
            if (tags.includes(this.settings.tagToMatchCase)) {
                namesWithCaseMatch = [...names];
                lowerCaseNames = names.filter((name) => aliasesWithIgnoreCase.has(name));
            } else {
                const prop = this.settings.capitalLetterProportionForAutomaticMatchCase;
                namesWithCaseMatch = [...names].filter(
                    (name) => PrefixTree.isUpperCaseString(name, prop) && !aliasesWithIgnoreCase.has(name)
                );
                namesWithCaseIgnore = [...names].filter((name) => !namesWithCaseMatch.includes(name));
            }
        }

        const namesToMoveFromIgnoreToMatch = namesWithCaseIgnore.filter((name) => aliasesWithMatchCase.has(name));
        const namesToMoveFromMatchToIgnore = namesWithCaseMatch.filter((name) => aliasesWithIgnoreCase.has(name));

        namesWithCaseIgnore = namesWithCaseIgnore.filter((name) => !namesToMoveFromIgnoreToMatch.includes(name));
        namesWithCaseMatch = namesWithCaseMatch.filter((name) => !namesToMoveFromMatchToIgnore.includes(name));
        namesWithCaseIgnore.push(...namesToMoveFromMatchToIgnore);
        namesWithCaseMatch.push(...namesToMoveFromIgnoreToMatch);

        namesWithCaseIgnore.push(...namesWithCaseIgnore.map((name) => name.toLowerCase()));

        namesWithCaseIgnore.forEach((name) => {
            this.addFileWithName(name, file, false);
        });

        namesWithCaseMatch.forEach((name) => {
            this.addFileWithName(name, file, true);
        });
    }

    private removeFileFromTree(file: TFile | string) {
        const path = typeof file === 'string' ? file : file.path;

        // Get the leaf nodes of the file
        const nodes = this.mapFilePathToLeaveNodes.get(path) ?? [];
        for (const node of nodes) {
            // Remove the file from the node
            node.files = new Set([...node.files].filter((f) => f.path !== path));
        }

        // If the nodes have no files or children, remove them from the tree
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            let currentNode = node;
            while (currentNode.files.size === 0 && currentNode.children.size === 0) {
                const parent = currentNode.parent;
                if (!parent || parent === this.root) {
                    break;
                }
                parent.children.delete(currentNode.charValue);
                currentNode = parent;
            }
        }

        // Remove the file from the set of indexed files
        this.setIndexedFilePaths.delete(path);
        this.mapFilePathToLeaveNodes.delete(path);

        // Remove the update time of the file
        this.mapIndexedFilePathsToUpdateTime.delete(path);
    }

    private fileIsUpToDate(file: TFile) {
        const mtime = file.stat.mtime;
        const path = file.path;
        return this.mapIndexedFilePathsToUpdateTime.has(path) && this.mapIndexedFilePathsToUpdateTime.get(path) === mtime;
    }

    updateTree(updateFiles?: (string | undefined)[]) {
        this.fetcher.refreshSettings();

        const currentVaultFiles = new Set<string>();
        let files = new Array<TFile>();
        const allFiles = this.app.vault.getMarkdownFiles();

        allFiles.forEach((f) => currentVaultFiles.add(f.path));

        // If the number of files has changed, update all files
        if (allFiles.length != this.setIndexedFilePaths.size || !updateFiles || updateFiles.length == 0) {
            files = allFiles;
        } else {
            // If files are provided, only update the provided files
            files = updateFiles
                .map((f) => (f ? this.app.vault.getAbstractFileByPath(f) : null))
                .filter((f) => f !== null && f instanceof TFile) as TFile[];
        }

        for (const file of files) {
            // Get the update time of the file
            const mtime = file.stat.mtime;

            // Check if the file has been updated
            if (this.fileIsUpToDate(file)) {
                continue;
            }
            // console.log("Updating", file, file.stat.mtime, this.mapIndexedFilePathsToUpdateTime.get(file.path));

            // Otherwise, add the file to the tree
            try {
                this.addFileToTree(file);
            } catch (e) {
                console.error('[VL LC] Error adding file to tree', file, e);
            }
        }

        // Remove files that are no longer in the vault
        const filesToRemove = [...this.setIndexedFilePaths].filter((f) => !currentVaultFiles.has(f));
        // console.log("Removing", filesToRemove);
        filesToRemove.forEach((f) => this.removeFileFromTree(f));
    }

    findFiles(prefix: string): Set<TFile> {
        let node: PrefixNode | undefined = this.root;
        for (const char of prefix) {
            node = node.children.get(char.toLowerCase());
            if (!node) {
                return new Set();
            }
        }
        return node.files;
    }

    resetSearch() {
        // this._current = this.root;
        this._currentNodes = [new VisitedPrefixNode(this.root)];
    }

    pushChar(char: string) {
        const newNodes: VisitedPrefixNode[] = [];
        const chars = [char];
        chars.push(char.toLowerCase());

        chars.forEach((c) => {
            // char = char.toLowerCase();
            const isBoundary = PrefixTree.checkWordBoundary(c);
            if (this.settings.matchAnyPartsOfWords || isBoundary || this.settings.matchEndOfWords) {
                // , this.settings.wordBoundaryRegex
                newNodes.push(new VisitedPrefixNode(this.root, true, isBoundary));
            }

            for (const node of this._currentNodes) {
                const child = node.node.children.get(c);
                const startedAtBoundary = node.startedAtWordBeginning;
                if (child) {
                    const newPrefixNodes = newNodes.map((n) => n.node);
                    if (!newPrefixNodes.includes(child)) {
                        const newVisited = new VisitedPrefixNode(child, char == c, startedAtBoundary);
                        newVisited.formattingDelta = node.formattingDelta;
                        newNodes.push(newVisited);
                    }
                }
            }

            // TODO: Ignore formatting (#59)
            if (false) {
                // Check if the current char is a formatting char, if so also add the current nodes
                const isFormatting = PrefixTree.isFormattingChar(char);
                if (isFormatting) {
                    this._currentNodes.forEach((node) => {
                        node.formattingDelta += 1;
                    });
                    newNodes.push(...this._currentNodes);
                }
            }
        });
        this._currentNodes = newNodes;
    }

    static checkWordBoundary(char: string): boolean {
        // , regexString: string
        // const pattern = /[\/\n\t\r\s,.!?:"`´()\[\]'{}|~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

        // let pattern = /[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

        // \p{L}: Any kind of letter from any language.
        // \p{Ll}: Lowercase letter.
        // \p{Lu}: Uppercase letter.
        // \p{M}: Mark (accents, combining marks).
        // \p{N}: Number (digit, letter-like number).
        // \p{P}: Punctuation.
        // \p{S}: Symbol (currency, math symbols, etc.).
        // \p{Z}: Separator (space, line breaks).
        // \p{C}: Other (control chars, unassigned, etc.).

        // let pattern = /[\p{P}\p{Z}\p{S}\p{C}\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
        let pattern = /[^\p{L}]/u;

        // if (regexString) {
        //     if (typeof regexString !== 'string') {
        //         regexString = regexString.toString();

        //     }
        //     if (!regexString.startsWith('/')) {
        //         regexString = '/' + regexString;
        //     }
        //     if (!regexString.endsWith('/')) {
        //         regexString = regexString + '/';
        //     }
        //     const parts = regexString.match(/\/(.*)\/([a-z]*)\/?/);
        //     if (!parts) {
        //         throw new Error('Invalid regex: ' + regexString);
        //     }
        //     pattern = new RegExp(parts[1], parts[2]);
        // }
        // console.log('Checking word boundary', char, pattern);
        return pattern.test(char);
    }

    static isFormattingChar(char: string): boolean {
        const pattern = /[^\p{L}\p{N}]/u;
        return pattern.test(char);
    }
}

export class CachedFile {
    constructor(public mtime: number, public file: TFile, public aliases: string[], public tags: string[]) { }
}

export class LinkerCache {
    static instance: LinkerCache;

    activeFilePath?: string;
    // files: Map<string, CachedFile> = new Map();
    // linkEntries: Map<string, CachedFile[]> = new Map();
    vault: Vault;
    cache: PrefixTree;

    constructor(public app: App, public settings: LinkerPluginSettings) {
        const { vault } = app;
        this.vault = vault;
        // console.log("Creating LinkerCache");
        this.cache = new PrefixTree(app, settings);
        this.updateCache(true);
    }

    static getInstance(app: App, settings: LinkerPluginSettings) {
        if (!LinkerCache.instance) {
            LinkerCache.instance = new LinkerCache(app, settings);
        }
        return LinkerCache.instance;
    }

    clearCache() {
        this.cache.clear();
    }

    reset() {
        this.cache.resetSearch();
    }

    updateCache(force = false) {
        // force = true;
        if (!this.app?.workspace?.getActiveFile()) {
            return;
        }

        // We only need to update cache if the active file has changed
        const activeFile = this.app.workspace.getActiveFile()?.path;
        if (activeFile === this.activeFilePath && !force) {
            return;
        }
        // console.log("Updating cache", force);
        this.cache.updateTree(force ? undefined : [activeFile, this.activeFilePath]);

        this.activeFilePath = activeFile;
    }
}
