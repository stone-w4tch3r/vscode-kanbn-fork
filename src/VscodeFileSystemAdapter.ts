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

    // For other files, store in our virtual file system only
    // We should only be writing to files that are explicitly being edited
    this.fileContentMap.set(normalizedPath, data)
    this.fileExistsMap.set(normalizedPath, true)
    this.onDidChangeEmitter.fire(vscode.Uri.file(filePath))
  }

  /**
   * Create directory - no-op in virtual file system
   */
  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    // In a virtual file system, we don't need to actually create directories
    // Just mark them as existing
    const normalizedPath = this.normalizePath(dirPath)
    this.fileExistsMap.set(normalizedPath, true)
  }

  /**
   * Rename file
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOldPath = this.normalizePath(oldPath)
    const normalizedNewPath = this.normalizePath(newPath)

    const content = this.fileContentMap.get(normalizedOldPath)
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`)
    }

    this.fileContentMap.set(normalizedNewPath, content)
    this.fileContentMap.delete(normalizedOldPath)
    this.fileExistsMap.set(normalizedNewPath, true)
    this.fileExistsMap.delete(normalizedOldPath)

    this.onDidChangeEmitter.fire(vscode.Uri.file(newPath))
  }

  /**
   * Delete file
   */
  async unlink(filePath: string): Promise<void> {
    const normalizedPath = this.normalizePath(filePath)

    this.fileContentMap.delete(normalizedPath)
    this.fileExistsMap.delete(normalizedPath)
    this.onDidChangeEmitter.fire(vscode.Uri.file(filePath))
  }

  /**
   * List files matching a glob pattern
   * This is a simplified implementation for the kanbn use case
   */
  async glob(pattern: string): Promise<string[]> {
    const results: string[] = []

    // First, add files from virtual file system
    const lastSlash = pattern.lastIndexOf('/')
    const directory = pattern.substring(0, lastSlash)
    const filePattern = pattern.substring(lastSlash + 1)

    // Simple pattern matching for *.md files
    if (filePattern === '*.md') {
      for (const [filePath] of this.fileContentMap) {
        if (filePath.startsWith(this.normalizePath(directory)) && filePath.endsWith('.md')) {
          results.push(filePath)
        }
      }
    }

    // Fall back to real file system using the standard glob library
    try {
      const glob = require("glob-promise")
      const realFiles = await glob(pattern)

      // Add real files that aren't already in virtual system
      for (const realFile of realFiles) {
        const normalizedReal = this.normalizePath(realFile)
        if (!this.fileContentMap.has(normalizedReal)) {
          results.push(realFile)
        }
      }
    } catch (error) {
      // If glob fails, that's okay - we'll just use virtual files
      console.warn(`Could not glob real file system: ${pattern}`, error)
    }

    return results
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