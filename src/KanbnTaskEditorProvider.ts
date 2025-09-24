import * as vscode from "vscode"
import * as path from "path"
import { Kanbn } from "@samgiz/kanbn/src/main"
import getNonce from "./getNonce"
import { VscodeFileSystemAdapter } from "./VscodeFileSystemAdapter"
import KanbnGlobalManager from "./KanbnGlobalManager"

// Debounce utility
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): T & { cancel: () => void } {
  let timeout: NodeJS.Timeout | null = null

  const debounced = ((...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(() => func(...args), wait)
  }) as T & { cancel: () => void }

  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  return debounced
}

class KanbnTaskDocument implements vscode.CustomDocument {
  static async create(
    uri: vscode.Uri,
    backupId: string | undefined,
    context: vscode.ExtensionContext
  ): Promise<KanbnTaskDocument> {
    const existing = backupId ? vscode.Uri.file(backupId) : uri
    const fileData = await KanbnTaskDocument.readFile(existing)
    return new KanbnTaskDocument(uri, fileData, context)
  }

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

  // Add a callback for notifying when undo/redo should refresh the webview
  private _onUndoRedo?: () => void

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

    // Initialize Kanbn instance with the board directory
    // Task file path: /workspace/.kanbn/tasks/taskId.md
    // Board path: /workspace/
    const tasksDir = path.dirname(uri.fsPath) // .kanbn/tasks
    const kanbnDir = path.dirname(tasksDir) // .kanbn
    const boardPath = path.dirname(kanbnDir) // workspace
    this._kanbn = new Kanbn(boardPath)
  }

  public get taskId(): string {
    // Extract task ID from filename (remove .md extension)
    const filename = path.basename(this._uri.fsPath)
    return filename.replace(/\.md$/, "")
  }

  /**
   * Initialize the Kanbn instance with VSCode file system adapter for webview context
   */
  initializeForWebview(): void {
    // Task file path: /workspace/.kanbn/tasks/taskId.md
    // Board path: /workspace/
    const tasksDir = path.dirname(this._uri.fsPath) // .kanbn/tasks
    const kanbnDir = path.dirname(tasksDir) // .kanbn
    const boardPath = path.dirname(kanbnDir) // workspace

    // Get global Kanbn instance for this board with document-specific adapter
    const globalManager = KanbnGlobalManager.getInstance()
    this._kanbn = globalManager.getKanbnForDocument(
      this._uri,
      boardPath,
      () => new TextDecoder().decode(this._documentData),
      (content: string) => {
        // Update the document data directly - the outer makeEdit will handle undo/redo
        this._documentData = new TextEncoder().encode(content)
      }
    )
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
    // Clean up global manager resources
    const tasksDir = path.dirname(this._uri.fsPath) // .kanbn/tasks
    const kanbnDir = path.dirname(tasksDir) // .kanbn
    const boardPath = path.dirname(kanbnDir) // workspace
    const globalManager = KanbnGlobalManager.getInstance()
    globalManager.cleanupDocument(this._uri, boardPath)

    this._onDidDispose.fire()
    this._onDidChangeDocument.dispose()
    this._onDidDispose.dispose()
    this._disposables.forEach((d) => d.dispose())
  }

  async makeEdit(label: string, editCallback: () => Promise<void>): Promise<void> {
    // Store the current state for the undo operation
    const oldDocumentData = new Uint8Array(this._documentData)
    console.log("makeEdit: oldDocumentData length:", oldDocumentData.length)

    // Execute the edit and wait for it to complete
    await editCallback()

    // Store the new state for the redo operation
    const newDocumentData = new Uint8Array(this._documentData)
    console.log("makeEdit: newDocumentData length:", newDocumentData.length)
    console.log(
      "makeEdit: data changed?",
      oldDocumentData.length !== newDocumentData.length ||
        !oldDocumentData.every((val, i) => val === newDocumentData[i])
    )

    // Fire the document change event with proper undo/redo implementations
    this._onDidChangeDocument.fire({
      label,
      undo: async () => {
        // Restore the old state
        this._documentData = oldDocumentData
        // Refresh the webview to show the undone state
        if (this._onUndoRedo) {
          this._onUndoRedo()
        }
      },
      redo: async () => {
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
    // Save the task file
    await vscode.workspace.fs.writeFile(this._uri, this._documentData)
  }

  async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    await vscode.workspace.fs.writeFile(targetResource, this._documentData)
  }

  async revert(cancellation: vscode.CancellationToken): Promise<void> {
    // Reload the task data
    const diskContent = await KanbnTaskDocument.readFile(this._uri)
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

export class KanbnTaskEditorProvider implements vscode.CustomEditorProvider<KanbnTaskDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new KanbnTaskEditorProvider(context)
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      KanbnTaskEditorProvider.viewType,
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

  private static readonly viewType = "kanbn.task"

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: { backupId?: string },
    _token: vscode.CancellationToken
  ): Promise<KanbnTaskDocument> {
    const document = await KanbnTaskDocument.create(uri, openContext.backupId, this.context)

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
    document: KanbnTaskDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    console.log('=== Task Editor resolveCustomEditor called ===')
    console.log('Document URI:', document.uri.fsPath)
    console.log('Task ID:', document.taskId)

    // Initialize Kanbn with file system adapter for webview context
    document.initializeForWebview()

    // Set up callback to refresh webview on undo/redo
    document.setUndoRedoCallback(() => {
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

    // Debounced edit function - groups rapid changes together
    const debouncedEdit = debounce(async (label: string, taskData: any) => {
      await document.makeEdit(label, async () => {
        // Update task data through kanbn
        if (document.taskId) {
          await document.kanbn.updateTask(document.taskId, taskData.task, taskData.column)
        } else {
          // Create new task
          await document.kanbn.createTask(taskData.task, taskData.column)
        }
      })
    }, 1500) // 1.5 second debounce

    console.log('Setting up message handler for task editor')
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      console.log('=== Task Editor received message ===', message.command, message)
      switch (message.command) {
        case "error":
          void vscode.window.showErrorMessage(message.text)
          return

        case "kanbn.updateMe":
          console.log('Handling kanbn.updateMe')
          void this.updateWebview(webviewPanel, document)
          return

        case "kanbn.textChange":
          console.log('Handling kanbn.textChange')
          // Debounced text changes
          debouncedEdit("Update task content", message.taskData)
          return

        case "kanbn.blur":
          console.log('Received kanbn.blur message', message.taskData)
          // Immediate edit on blur (cancel debounce and apply immediately)
          debouncedEdit.cancel()
          await document.makeEdit("Update task content", async () => {
            console.log('Inside makeEdit callback, taskId:', document.taskId)
            if (document.taskId) {
              console.log('Calling updateTask')
              await document.kanbn.updateTask(
                document.taskId,
                message.taskData.task,
                message.taskData.column
              )
            } else {
              console.log('Calling createTask')
              await document.kanbn.createTask(message.taskData.task, message.taskData.column)
            }
            console.log('Task operation completed')
          })
          return

        case "kanbn.save":
          // Explicit save action
          debouncedEdit.cancel()
          await document.makeEdit("Save task", async () => {
            if (document.taskId) {
              await document.kanbn.updateTask(
                document.taskId,
                message.taskData.task,
                message.taskData.column
              )
            } else {
              await document.kanbn.createTask(message.taskData.task, message.taskData.column)
            }
          })
          void this.updateWebview(webviewPanel, document)
          return
      }
    })

    void this.updateWebview(webviewPanel, document)
  }

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<KanbnTaskDocument>
  >()
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event

  public saveCustomDocument(
    document: KanbnTaskDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.save(cancellation)
  }

  public saveCustomDocumentAs(
    document: KanbnTaskDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.saveAs(destination, cancellation)
  }

  public revertCustomDocument(
    document: KanbnTaskDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.revert(cancellation)
  }

  public backupCustomDocument(
    document: KanbnTaskDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Thenable<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation)
  }

  // Adapted from KanbnTaskPanel._getTaskData()
  private async getTaskData(document: KanbnTaskDocument): Promise<null | any> {
    let index: any
    try {
      index = await document.kanbn.getIndex()
    } catch (error) {
      if (error instanceof Error) {
        void vscode.window.showErrorMessage(error.message)
      } else {
        throw error
      }
      return null
    }
    let tasks: any[]
    try {
      tasks = (await document.kanbn.loadAllTrackedTasks(index)).map((task) => ({
        ...document.kanbn.hydrateTask(index, task),
      }))
    } catch (error) {
      if (error instanceof Error) {
        void vscode.window.showErrorMessage(error.message)
      } else {
        throw error
      }
      return null
    }
    let task: any | null = null
    if (document.taskId !== null) {
      task = tasks.find((t) => t.id === document.taskId) ?? null
    }

    // Use column of task, or first column if task doesn't exist yet.
    const columnName = task?.column ?? Object.keys(index.columns)[0]

    // Send task data to the webview
    return {
      index,
      task,
      tasks,
      customFields: index.options.customFields ?? [],
      columnName,
      dateFormat: document.kanbn.getDateFormat(index),
    }
  }

  private async updateWebview(
    webviewPanel: vscode.WebviewPanel,
    document: KanbnTaskDocument
  ): Promise<void> {
    console.log('updateWebview called for task editor')
    // Send task data to the webview (matching KanbnTaskPanel.update())
    const taskData = await this.getTaskData(document)
    console.log('Sending task data to webview:', taskData)
    void webviewPanel.webview.postMessage(taskData)
  }

  private getHtmlForWebview(webview: vscode.Webview, document: KanbnTaskDocument): string {
    // Use the existing webview assets that handle both board and task components
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "webview-ui", "out", "index.js"))
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "webview-ui", "out", "index.css"))
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
<title>Task Editor</title>
<link rel="stylesheet" type="text/css" href="${styleUri.toString()}">
<link rel="stylesheet" type="text/css" href="${codiconsUri.toString()}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https:; script-src 'nonce-${nonce}'; font-src vscode-webview-resource:; style-src vscode-webview-resource: 'unsafe-inline' http: https: data:;">
<base href="${webview
      .asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "out")))
      .toString()}/">
</head>
<body>
<noscript>You need to enable JavaScript to run this app.</noscript>
<div id="root-task"></div>
<script nonce="${nonce}">
</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}
