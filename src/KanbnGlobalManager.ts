import * as vscode from "vscode"
import * as path from "path"
import { Kanbn } from "@samgiz/kanbn/src/main"
import { VscodeFileSystemAdapter } from "./VscodeFileSystemAdapter"

interface DocumentAdapter {
  adapter: VscodeFileSystemAdapter
  documentCallbacks: Map<string, () => void>
}

/**
 * Global manager for Kanbn instances and file system adapters
 * Ensures we reuse instances per board path and manage memory efficiently
 */
class KanbnGlobalManager {
  private static instance: KanbnGlobalManager | null = null

  // Map from board path to Kanbn instance
  private kanbnInstances = new Map<string, Kanbn>()

  // Map from board path to document adapter info
  private documentAdapters = new Map<string, DocumentAdapter>()

  private constructor() {}

  static getInstance(): KanbnGlobalManager {
    if (!KanbnGlobalManager.instance) {
      KanbnGlobalManager.instance = new KanbnGlobalManager()
    }
    return KanbnGlobalManager.instance
  }

  /**
   * Get or create a Kanbn instance for a board path with document-specific adapter
   */
  getKanbnForDocument(
    documentUri: vscode.Uri,
    boardPath: string,
    getDocumentContent: () => string,
    setDocumentContent: (content: string) => void
  ): Kanbn {
    const documentKey = documentUri.fsPath

    // Get or create document adapter for this board
    let documentAdapterInfo = this.documentAdapters.get(boardPath)
    if (!documentAdapterInfo) {
      // Create a new adapter for this board
      const adapter = new VscodeFileSystemAdapter(
        documentUri,
        getDocumentContent,
        setDocumentContent
      )

      documentAdapterInfo = {
        adapter,
        documentCallbacks: new Map()
      }
      this.documentAdapters.set(boardPath, documentAdapterInfo)
    } else {
      // Update the existing adapter with this document's callbacks
      documentAdapterInfo.adapter.addDocumentCallbacks(
        documentUri,
        getDocumentContent,
        setDocumentContent
      )
    }

    // Store the document callback for cleanup later
    documentAdapterInfo.documentCallbacks.set(documentKey, () => {
      documentAdapterInfo!.adapter.removeDocumentCallbacks(documentUri)
    })

    // Get or create Kanbn instance for this board path
    let kanbn = this.kanbnInstances.get(boardPath)
    if (!kanbn) {
      // Create glob function that uses the adapter
      const globFunction = async (pattern: string) => {
        return await documentAdapterInfo!.adapter.glob(pattern)
      }

      // Create new Kanbn instance with the adapter
      kanbn = new Kanbn(boardPath, documentAdapterInfo.adapter, globFunction)
      this.kanbnInstances.set(boardPath, kanbn)
    }

    return kanbn
  }

  /**
   * Clean up resources for a document
   */
  cleanupDocument(documentUri: vscode.Uri, boardPath: string): void {
    const documentKey = documentUri.fsPath
    const documentAdapterInfo = this.documentAdapters.get(boardPath)

    if (documentAdapterInfo) {
      // Remove this document's callbacks
      const cleanup = documentAdapterInfo.documentCallbacks.get(documentKey)
      if (cleanup) {
        cleanup()
        documentAdapterInfo.documentCallbacks.delete(documentKey)
      }

      // If no more documents are using this adapter, clean up the board resources
      if (documentAdapterInfo.documentCallbacks.size === 0) {
        this.documentAdapters.delete(boardPath)
        this.kanbnInstances.delete(boardPath)
      }
    }
  }

  /**
   * Get current stats for debugging
   */
  getStats() {
    return {
      kanbnInstances: this.kanbnInstances.size,
      documentAdapters: this.documentAdapters.size,
      totalDocuments: Array.from(this.documentAdapters.values())
        .reduce((sum, adapter) => sum + adapter.documentCallbacks.size, 0)
    }
  }
}

export default KanbnGlobalManager