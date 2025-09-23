import * as vscode from "vscode"
import * as path from "path"
import getNonce from "./getNonce"
import { Kanbn, index as kanbn_index, task as kanbn_task } from "@samgiz/kanbn/src/main"
import { VscodeFileSystemAdapter } from "./VscodeFileSystemAdapter"

const sortByFields: Record<string, string> = {
  Name: "name",
  Created: "created",
  Updated: "updated",
  Started: "started",
  Completed: "completed",
  Due: "due",
  Assigned: "assigned",
  "Count sub-tasks": "countSubTasks",
  "Count tags": "countTags",
  "Count relations": "countRelations",
  "Count comments": "countComments",
  Workload: "workload",
}

class KanbnBoardDocument implements vscode.CustomDocument {
  static async create(
    uri: vscode.Uri,
    backupId: string | undefined,
    context: vscode.ExtensionContext
  ): Promise<KanbnBoardDocument> {
    const existing = backupId ? vscode.Uri.file(backupId) : uri
    const fileData = await KanbnBoardDocument.readFile(existing)
    return new KanbnBoardDocument(uri, fileData, context)
  }

  // Add a callback for notifying when undo/redo should refresh the webview
  private _onUndoRedo?: () => void

  private static async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (uri.scheme === "untitled") {
      return new Uint8Array()
    }
    return await vscode.workspace.fs.readFile(uri)
  }

  private readonly _uri: vscode.Uri
  private _documentData: Uint8Array
  private readonly _context: vscode.ExtensionContext
  private _kanbn: Kanbn
  private readonly _disposables: vscode.Disposable[] = []

  private readonly _onDidDispose = new vscode.EventEmitter<void>()
  public readonly onDidDispose = this._onDidDispose.event

  private readonly _onDidChangeDocument = new vscode.EventEmitter<{
    readonly label: string
    undo(): void
    redo(): void
  }>()
  public readonly onDidChangeDocument = this._onDidChangeDocument.event

  private constructor(
    uri: vscode.Uri,
    initialContent: Uint8Array,
    context: vscode.ExtensionContext
  ) {
    this._uri = uri
    this._documentData = initialContent
    this._context = context

    // Initialize Kanbn instance with the board directory (parent of .kanbn)
    const kanbnDir = path.dirname(uri.fsPath) // This gives us /.kanbn/
    const boardPath = path.dirname(kanbnDir) // This gives us the actual board directory
    this._kanbn = new Kanbn(boardPath)
  }

  /**
   * Initialize the Kanbn instance with VSCode file system adapter for webview context
   */
  initializeForWebview(): void {
    const kanbnDir = path.dirname(this._uri.fsPath)
    const boardPath = path.dirname(kanbnDir)

    // Create file system adapter that works with this document
    const fileSystemAdapter = new VscodeFileSystemAdapter(
      this._uri,
      () => new TextDecoder().decode(this._documentData),
      (content: string) => {
        // Update the document data directly - the outer makeEdit will handle undo/redo
        this._documentData = new TextEncoder().encode(content)
      }
    )

    // Create glob function that uses the adapter
    const globFunction = async (pattern: string) => {
      return await fileSystemAdapter.glob(pattern)
    }

    // Replace the regular Kanbn instance with one using the file system adapter
    this._kanbn = new Kanbn(boardPath, fileSystemAdapter, globFunction)
  }

  public get uri() {
    return this._uri
  }
  public get documentData() {
    return this._documentData
  }
  public get kanbn() {
    return this._kanbn
  }

  setUndoRedoCallback(callback: () => void): void {
    this._onUndoRedo = callback
  }

  dispose(): void {
    this._onDidDispose.fire()
    this._onDidChangeDocument.dispose()
    this._onDidDispose.dispose()
    this._disposables.forEach((d) => d.dispose())
  }

  async makeEdit(label: string, editCallback: () => Promise<void>): Promise<void> {
    // Store the current state for the undo operation
    const oldDocumentData = new Uint8Array(this._documentData)

    // Execute the edit and wait for it to complete
    await editCallback()

    // Store the new state for the redo operation
    const newDocumentData = new Uint8Array(this._documentData)

    // Fire the document change event with proper undo/redo implementations
    this._onDidChangeDocument.fire({
      label,
      undo: async () => {
        console.log("[DEBUG] Undo called - restoring old state")
        // Restore the old state
        this._documentData = oldDocumentData
        // Refresh the webview to show the undone state
        if (this._onUndoRedo) {
          this._onUndoRedo()
        }
      },
      redo: async () => {
        console.log("[DEBUG] Redo called - restoring new state")
        // Restore the new state
        this._documentData = newDocumentData
        // Refresh the webview to show the redone state
        if (this._onUndoRedo) {
          this._onUndoRedo()
        }
      },
    })
  }

  async save(cancellation: vscode.CancellationToken): Promise<void> {
    // Save the main index file
    await vscode.workspace.fs.writeFile(this._uri, this._documentData)
  }

  async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    // Copy the entire kanbn directory structure to the new location
    await vscode.workspace.fs.writeFile(targetResource, this._documentData)
  }

  async revert(cancellation: vscode.CancellationToken): Promise<void> {
    // Reload the kanbn data
    const diskContent = await KanbnBoardDocument.readFile(this._uri)
    this._documentData = diskContent
  }

  async backup(
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    await this.saveAs(destination, cancellation)
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination)
        } catch {
          // ignore
        }
      },
    }
  }
}

export class KanbnBoardEditorProvider implements vscode.CustomEditorProvider<KanbnBoardDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new KanbnBoardEditorProvider(context)
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      KanbnBoardEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
    return providerRegistration
  }

  private static readonly viewType = "kanbn.board"

  // Note: Task panels are now handled by custom editor, so this map is no longer needed

  constructor(private readonly context: vscode.ExtensionContext) {}

  public showTaskPanel(
    document: KanbnBoardDocument,
    taskId: string | null,
    column: string | null = null
  ): void {
    console.log("[TASK DEBUG] showTaskPanel called with taskId:", taskId, "column:", column)
    if (taskId) {
      // Open existing task using custom editor
      const kanbnDir = path.dirname(document.uri.fsPath)
      const taskUri = vscode.Uri.file(path.join(kanbnDir, "tasks", `${taskId}.md`))
      console.log("[TASK DEBUG] Opening task with URI:", taskUri.toString())

      vscode.commands.executeCommand("vscode.openWith", taskUri, "kanbn.task").then(
        () => {
          console.log("[TASK DEBUG] vscode.openWith command executed successfully")
        },
        (error) => {
          console.log("[TASK DEBUG] Error executing vscode.openWith:", error)
        }
      )
    } else {
      // For new tasks, we'll need to create a temporary file or use a different approach
      // This is more complex and might need a different solution
      console.log("[TASK DEBUG] New task creation not yet implemented")
      vscode.window.showInformationMessage(
        "Creating new tasks through custom editor is not yet implemented"
      )
    }
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: { backupId?: string },
    _token: vscode.CancellationToken
  ): Promise<KanbnBoardDocument> {
    const document = await KanbnBoardDocument.create(uri, openContext.backupId, this.context)

    const listeners: vscode.Disposable[] = []

    listeners.push(
      document.onDidChangeDocument((e) => {
        this._onDidChangeCustomDocument.fire({
          document,
          ...e,
        })
      })
    )

    document.onDidDispose(() => listeners.forEach((l) => l.dispose()))

    return document
  }

  async resolveCustomEditor(
    document: KanbnBoardDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Initialize the document with VSCode file system adapter for webview context
    document.initializeForWebview()

    // Set up callback to refresh webview on undo/redo
    document.setUndoRedoCallback(() => {
      console.log("[DEBUG] Webview refresh callback called")
      this.updateWebview(webviewPanel, document)
    })

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "out")),
        vscode.Uri.file(path.join(this.context.extensionPath, "webview-ui", "out")),
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        vscode.Uri.file(
          path.join(this.context.extensionPath, "node_modules", "@vscode/codicons", "dist")
        ),
      ],
    }

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document)

    // Listen for file system changes to refresh the webview (handles undo/redo)
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(path.dirname(document.uri.fsPath))),
        "**/.kanbn/**"
      )
    )

    const refreshWebview = () => {
      this.updateWebview(webviewPanel, document)
    }

    watcher.onDidChange(refreshWebview)
    watcher.onDidCreate(refreshWebview)
    watcher.onDidDelete(refreshWebview)

    // Clean up watcher when panel is disposed
    webviewPanel.onDidDispose(() => {
      watcher.dispose()
    })

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "error":
          void vscode.window.showErrorMessage(message.text)
          return

        case "kanbn.updateMe":
          void this.updateWebview(webviewPanel, document)
          return

        case "kanbn.task":
          this.showTaskPanel(document, message.taskId, message.columnName)
          return

        case "kanbn.move":
          await document.makeEdit(`Move task ${message.task}`, async () => {
            try {
              await document.kanbn.moveTask(message.task, message.columnName, message.position)
            } catch (e) {
              if (e instanceof Error) {
                void vscode.window.showErrorMessage(e.message)
              } else {
                throw e
              }
            }
          })
          return

        case "kanbn.addTask":
          this.showTaskPanel(document, null, message.columnName)
          return

        case "kanbn.sortColumn":
          await this.handleSortColumn(message, document, webviewPanel)
          return

        case "kanbn.burndown":
          // TODO: Implement burndown chart
          return

        case "kanbn.sprint":
          await this.handleSprint(message, document, webviewPanel)
          return
      }
    })

    void this.updateWebview(webviewPanel, document)
  }

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<KanbnBoardDocument>
  >()
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event

  public saveCustomDocument(
    document: KanbnBoardDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.save(cancellation)
  }

  public saveCustomDocumentAs(
    document: KanbnBoardDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.saveAs(destination, cancellation)
  }

  public revertCustomDocument(
    document: KanbnBoardDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.revert(cancellation)
  }

  public backupCustomDocument(
    document: KanbnBoardDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Thenable<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation)
  }

  private async updateWebview(
    webviewPanel: vscode.WebviewPanel,
    document: KanbnBoardDocument
  ): Promise<void> {
    console.log("[DEBUG] updateWebview called")
    console.log("[DEBUG] Document data length:", document.documentData.length)
    console.log(
      "[DEBUG] Document data first 100 chars:",
      new TextDecoder().decode(document.documentData)
    )
    let index: kanbn_index
    try {
      index = await document.kanbn.getIndex()
      console.log("[DEBUG] Index retrieved, columns:", Object.keys(index.columns))
    } catch (error) {
      if (error instanceof Error) {
        void vscode.window.showErrorMessage(error.message)
      } else {
        throw error
      }
      return
    }

    let tasks: kanbn_task[]
    try {
      tasks = (await document.kanbn.loadAllTrackedTasks(index)).map((task) =>
        document.kanbn.hydrateTask(index, task)
      )
    } catch (error) {
      if (error instanceof Error) {
        void vscode.window.showErrorMessage(error.message)
      } else {
        throw error
      }
      return
    }

    void webviewPanel.webview.postMessage({
      type: "index",
      index,
      tasks,
      hiddenColumns: index.options.hiddenColumns ?? [],
      startedColumns: index.options.startedColumns ?? [],
      completedColumns: index.options.completedColumns ?? [],
      columnSorting: index.options.columnSorting ?? {},
      customFields: index.options.customFields ?? [],
      dateFormat: document.kanbn.getDateFormat(index),
      showBurndownButton: vscode.workspace.getConfiguration("kanbn").get("showBurndownButton"),
      showSprintButton: vscode.workspace.getConfiguration("kanbn").get("showSprintButton"),
    })

    // Update the panel title
    webviewPanel.title = index.name
  }

  private async handleSortColumn(
    message: any,
    document: KanbnBoardDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const index = await document.kanbn.getIndex()
    let customFields: string[] = []
    if ("customFields" in index.options) {
      customFields = index.options.customFields.map(
        (customField: { name: string; type: string }) => customField.name
      )
    }

    const sortBy: string | undefined = await vscode.window.showQuickPick(
      ["None", ...Object.keys(sortByFields), ...customFields],
      {
        placeHolder: "Sort this column by...",
        canPickMany: false,
      }
    )

    if (sortBy !== undefined) {
      if (sortBy === "None") {
        await document.makeEdit(`Clear sort for ${message.columnName}`, async () => {
          await document.kanbn.sort(message.columnName, [], false)
        })
        await this.updateWebview(webviewPanel, document)
        return
      }

      const sortDirection = await vscode.window.showQuickPick(["Ascending", "Descending"], {
        placeHolder: "Sort direction",
        canPickMany: false,
      })

      if (sortDirection !== undefined) {
        const saveSort = await vscode.window.showQuickPick(["Yes", "No"], {
          placeHolder: "Save sort settings for this column?",
          canPickMany: false,
        })

        if (saveSort !== undefined) {
          await document.makeEdit(`Sort ${message.columnName} by ${sortBy}`, async () => {
            await document.kanbn.sort(
              message.columnName,
              [
                {
                  field: sortBy in sortByFields ? sortByFields[sortBy] : sortBy,
                  order: sortDirection === "Descending" ? "descending" : "ascending",
                },
              ],
              saveSort === "Yes"
            )
          })
          await this.updateWebview(webviewPanel, document)
        }
      }
    }
  }

  private async handleSprint(
    message: any,
    document: KanbnBoardDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const newSprintName = await vscode.window.showInputBox({
      placeHolder: "The sprint name.",
    })

    if (newSprintName !== undefined) {
      await document.makeEdit(`Start sprint: ${newSprintName}`, async () => {
        try {
          await document.kanbn.sprint(newSprintName, "", new Date())
        } catch (e) {
          if (e instanceof Error) {
            void vscode.window.showErrorMessage(e.message)
          } else {
            throw e
          }
        }
      })
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, document: KanbnBoardDocument): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "webview-ui", "out", "index.js"))
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "webview-ui", "out", "index.css"))
    )

    const customStyleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), "board.css"))
    )
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(
          this.context.extensionPath,
          "node_modules",
          "@vscode/codicons",
          "dist",
          "codicon.css"
        )
      )
    )

    const nonce = getNonce()

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
<meta name="theme-color" content="#000000">
<title>Kanbn Board</title>
<link rel="stylesheet" type="text/css" href="${styleUri.toString()}">
<link rel="stylesheet" type="text/css" href="${customStyleUri.toString()}">
<link rel="stylesheet" type="text/css" href="${codiconsUri.toString()}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https:; script-src 'nonce-${nonce}'; font-src vscode-webview-resource:; style-src vscode-webview-resource: 'unsafe-inline' http: https: data:;">
<base href="${webview
      .asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "out")))
      .toString()}/">
</head>
<body>
<noscript>You need to enable JavaScript to run this app.</noscript>
<div id="root-board"></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
  }
}
