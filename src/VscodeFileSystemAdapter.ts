import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

/**
 * VSCode file system adapter that implements the fs.promises interface
 * for use with the kanbn library in webview contexts
 */
export class VscodeFileSystemAdapter {
  private documentUri: vscode.Uri
  private getDocumentContent: () => string
  private setDocumentContent: (content: string) => void
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>()
  private fileContentMap = new Map<string, string>()
  private fileExistsMap = new Map<string, boolean>()

  constructor(
    documentUri: vscode.Uri,
    getDocumentContent: () => string,
    setDocumentContent: (content: string) => void
  ) {
    this.documentUri = documentUri
    this.getDocumentContent = getDocumentContent
    this.setDocumentContent = setDocumentContent
  }

  /**
   * Check if a file exists and is accessible
   */
  async access(filePath: string, mode?: number): Promise<void> {
    const normalizedPath = this.normalizePath(filePath)

    // For the main index file, it always exists in custom editor context
    if (this.isMainIndexFile(normalizedPath)) {
      return
    }

    // For other files, check our virtual file system first
    if (this.fileExistsMap.has(normalizedPath)) {
      if (!this.fileExistsMap.get(normalizedPath)) {
        throw new Error(`ENOENT: no such file or directory, access '${filePath}'`)
      }
      return
    }

    // Fall back to real file system for files not in virtual system
    try {
      await fs.promises.access(filePath, mode || (fs.constants.R_OK | fs.constants.W_OK))
    } catch (error) {
      throw new Error(`ENOENT: no such file or directory, access '${filePath}'`)
    }
  }

  /**
   * Read file contents as string
   */
  async readFile(filePath: string, options?: { encoding: string }): Promise<string> {
    const normalizedPath = this.normalizePath(filePath)

    // For the main index file, return the document content
    if (this.isMainIndexFile(normalizedPath)) {
      return this.getDocumentContent()
    }

    // For other files, check virtual file system first
    if (this.fileContentMap.has(normalizedPath)) {
      return this.fileContentMap.get(normalizedPath)!
    }

    // Fall back to real file system for files not in virtual system
    try {
      return await fs.promises.readFile(filePath, { encoding: "utf-8" })
    } catch (error) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
    }
  }

  /**
   * Write file contents
   */
  async writeFile(filePath: string, data: string): Promise<void> {
    const normalizedPath = this.normalizePath(filePath)

    // For the main index file, we need to update the document
    if (this.isMainIndexFile(normalizedPath)) {
      this.setDocumentContent(data)
      return
    }

    // For other files (like task files), write directly to the real file system
    // This ensures file watchers detect changes and the board refreshes
    try {
      await fs.promises.writeFile(filePath, data)
    } catch (error) {
      console.error(`Could not write to file system: ${filePath}`, error)
      throw error
    }
  }

  /**
   * Create directory - use real file system for non-virtual directories
   */
  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    // Use real file system for directory creation
    try {
      await fs.promises.mkdir(dirPath, options)
    } catch (error) {
      // Ignore if directory already exists
      if ((error as any).code !== 'EEXIST') {
        throw error
      }
    }
  }

  /**
   * Rename file
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    // Use real file system for file operations
    try {
      await fs.promises.rename(oldPath, newPath)
    } catch (error) {
      throw new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`)
    }
  }

  /**
   * Delete file
   */
  async unlink(filePath: string): Promise<void> {
    // Use real file system for file deletion
    try {
      await fs.promises.unlink(filePath)
    } catch (error) {
      // Ignore if file doesn't exist
      if ((error as any).code !== 'ENOENT') {
        throw error
      }
    }
  }

  /**
   * List files matching a glob pattern
   * Use real file system since we're not virtualizing task files anymore
   */
  async glob(pattern: string): Promise<string[]> {
    try {
      const glob = require("glob-promise")
      return await glob(pattern)
    } catch (error) {
      console.warn(`Could not glob file system: ${pattern}`, error)
      return []
    }
  }

  /**
   * Get file change events
   */
  get onDidChange(): vscode.Event<vscode.Uri> {
    return this.onDidChangeEmitter.event
  }

  /**
   * Initialize with existing files (if any) from the workspace
   */
  async initialize(): Promise<void> {
    // This could be extended to load existing task files from the workspace
    // For now, we'll start with an empty virtual file system
  }

  /**
   * Get all virtual files for saving to workspace
   */
  getVirtualFiles(): Map<string, string> {
    return new Map(this.fileContentMap)
  }

  /**
   * Normalize file paths for consistent comparison
   */
  private normalizePath(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/')
  }

  /**
   * Check if the given path is the main index file being edited
   */
  private isMainIndexFile(normalizedPath: string): boolean {
    const documentPath = this.normalizePath(this.documentUri.fsPath)
    return normalizedPath === documentPath
  }
}