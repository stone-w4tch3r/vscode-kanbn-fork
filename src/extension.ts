import * as vscode from "vscode"
import * as path from "path"
import KanbnStatusBarItem from "./KanbnStatusBarItem"
import KanbnBurndownPanel from "./KanbnBurndownPanel"
import { KanbnBoardEditorProvider } from "./KanbnBoardEditorProvider"
import { KanbnTaskEditorProvider } from "./KanbnTaskEditorProvider"
import { Kanbn } from "@samgiz/kanbn/src/main"
import KanbnGlobalManager from "./KanbnGlobalManager"
import * as fs from "fs"

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Register the custom editor providers
  context.subscriptions.push(KanbnBoardEditorProvider.register(context))
  context.subscriptions.push(KanbnTaskEditorProvider.register(context))

  const kanbnStatusBarItem: KanbnStatusBarItem = new KanbnStatusBarItem(context, null)
  const globalManager = KanbnGlobalManager.getInstance()

  // Track discovered board locations (no instances created yet)
  const boardLocations = new Set<string>()

  // Lazy-created burndown panels
  const burndownPanels = new Map<string, KanbnBurndownPanel>()

  // Helper to lazily get Kanbn instance for a board
  function getKanbnForBoard(boardPath: string): Kanbn {
    const dummyUri = vscode.Uri.file(`${boardPath}/.kanbn/index.md`)
    return globalManager.getKanbnForDocument(
      dummyUri,
      boardPath,
      () => "", // dummy getter
      () => {}  // dummy setter
    )
  }

  // Helper to lazily get or create burndown panel for a board
  function getBurndownPanel(boardPath: string): KanbnBurndownPanel {
    let panel = burndownPanels.get(boardPath)
    if (!panel && vscode.workspace.workspaceFolders) {
      const kanbn = getKanbnForBoard(boardPath)
      panel = KanbnBurndownPanel.create(
        context.extensionPath,
        vscode.workspace.workspaceFolders[0].uri.fsPath,
        kanbn,
        boardPath
      )
      burndownPanels.set(boardPath, panel)
    }
    return panel!
  }

  async function chooseBoard(): Promise<string | undefined> {
    if (boardLocations.size === 0) {
      void vscode.window.showErrorMessage(
        "No boards detected. Open a workspace with Kanbn boards or add Additional Boards to the global user configuration"
      )
      return
    }
    const boardNames: string[] = [...boardLocations]
    const options: vscode.QuickPickOptions = {
      placeHolder: "Select a board to open",
      canPickMany: false,
    }
    const item: string | undefined = await vscode.window.showQuickPick(boardNames, options)
    return item
  }

  function populateBoardCache(): void {
    // Clear existing locations and rediscover
    boardLocations.clear()

    // Get globally accessible board locations.
    vscode.workspace
      .getConfiguration("kanbn", null)
      .get<string[]>("additionalBoards")
      ?.forEach((boardLocation) => {
        boardLocations.add(path.resolve(boardLocation))
      })

    // Get standard board locations.
    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      // Get workspace specific board locations.
      vscode.workspace
        .getConfiguration("kanbn", workspaceFolder.uri)
        .get<string[]>("additionalBoards")
        ?.forEach((boardLocation) => {
          boardLocations.add(path.resolve(boardLocation))
        })

      // For backwards compatibility, check the old kanbn directory (which is just the current workspace directory).
      const oldKanbnPath = `${workspaceFolder.uri.fsPath}`
      if (fs.existsSync(`${oldKanbnPath}/.kanbn`)) {
        boardLocations.add(path.resolve(oldKanbnPath))
      }
      // Populate boards in the standard workspace location.
      const kanbnPath = `${workspaceFolder.uri.fsPath}/.kanbn_boards`
      if (fs.existsSync(kanbnPath)) {
        for (const kanbnBoardPath of fs.readdirSync(kanbnPath)) {
          boardLocations.add(path.resolve(`${kanbnPath}/${kanbnBoardPath}`))
        }
      }
    }

    // Set up file watchers for discovered board locations
    for (const boardLocation of boardLocations) {
      const fileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(`${boardLocation}/.kanbn`), "**")
      )

      fileWatcher.onDidChange(() => {
        // Lazily get instances only when file changes occur
        const kanbn = getKanbnForBoard(boardLocation)
        void kanbnStatusBarItem.update(kanbn)

        // Update burndown panel if it exists
        const panel = burndownPanels.get(boardLocation)
        if (panel) {
          void panel.update()
        }
      })
    }
  }
  populateBoardCache()

  // Register a command to initialise Kanbn in the current workspace. This command will be invoked when the status
  // bar item is clicked in a workspace where Kanbn isn't already initialised.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.createBoard", async () => {
      // If no workspace folder is opened, we can't initialise kanbn
      if (vscode.workspace.workspaceFolders === undefined) {
        void vscode.window.showErrorMessage(
          "You need to open a workspace before initialising Kanbn."
        )
        return
      }
      // Prompt for a new project name
      const getNewBoardName = (): Thenable<string | undefined> => {
        const newBoardName = vscode.window.showInputBox({
          placeHolder: "The project name.",
          validateInput: (text) => {
            return text.length < 1 ? "The project name cannot be empty." : null
          },
        })
        return newBoardName
      }
      let boardName = await getNewBoardName()
      // If the input prompt wasn't cancelled, initialise kanbn
      while (boardName !== undefined) {
        const boardLocation: string = `${vscode.workspace.workspaceFolders[0].uri.fsPath}/.kanbn_boards/${boardName}`
        if (fs.existsSync(boardLocation)) {
          void vscode.window.showErrorMessage(
            "A board with that name already exists. Pick a different name."
          )
          boardName = await getNewBoardName()
          continue
        }
        fs.mkdirSync(boardLocation, { recursive: true })
        // Initialize the board using lazy-loaded Kanbn instance
        const kanbn = getKanbnForBoard(boardLocation)
        void kanbn.initialise({
          name: boardName,
        })

        // Add the new board to our locations set
        boardLocations.add(boardLocation)

        // Initialize file watcher
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.workspace.workspaceFolders[0],
            `.kanbn_boards/${boardName}/**.*`
          )
        )
        fileWatcher.onDidChange(() => {
          const kanbn = getKanbnForBoard(boardLocation)
          void kanbnStatusBarItem.update(kanbn)

          // Update burndown panel if it exists
          const panel = burndownPanels.get(boardLocation)
          if (panel) {
            void panel.update()
          }
        })
        void vscode.window.showInformationMessage(`Created Kanbn board '${boardLocation}'.`)
        break
      }
    })
  )

  // Register a command to open the kanbn board. This command will be invoked when the status bar item is clicked
  // in a workspace where kanbn has already been initialised.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.openBoard", async () => {
      const board = await chooseBoard()
      if (board === undefined) {
        return
      }

      // If kanbn is initialised, view the kanbn board using custom editor
      const indexPath = `${board}/.kanbn/index.md`
      const indexUri = vscode.Uri.file(indexPath)
      await vscode.commands.executeCommand('vscode.openWith', indexUri, 'kanbn.board')

      // Update status bar with lazy-loaded kanbn instance
      const kanbn = getKanbnForBoard(board)
      void kanbnStatusBarItem.update(kanbn)
    })
  )

  // Register a command to add a new kanbn task.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.addTask", async () => {
      // Choose board to add task to
      const board = await chooseBoard()
      if (board === undefined) return

      // Create a new task file and open it with the custom editor
      const kanbn = getKanbnForBoard(board)
      const index = await kanbn.getIndex()

      // Generate a unique task ID for new task
      const taskId = `new-task-${Date.now()}`
      const taskPath = `${board}/.kanbn/tasks/${taskId}.md`
      const taskUri = vscode.Uri.file(taskPath)

      // Create an empty task file
      await vscode.workspace.fs.writeFile(taskUri, new TextEncoder().encode(''))

      // Open with custom task editor
      await vscode.commands.executeCommand('vscode.openWith', taskUri, 'kanbn.task')
    })
  )

  // Register a command to open an existing kanbn task.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.openTask", async () => {
      // If no workspace folder is opened, we can't open a task
      if (vscode.workspace.workspaceFolders === undefined) {
        void vscode.window.showErrorMessage("You need to open a workspace before opening a task.")
        return
      }

      // Choose board to open a task from
      const board = await chooseBoard()
      if (board === undefined) return

      // Get kanbn instance for the board
      const kanbn = getKanbnForBoard(board)
      const index = await kanbn.getIndex()
      const startedColumns: string[] = index.options?.startedColumns ?? []
      const completedColumns: string[] = index.options?.completedColumns ?? []
      const otherColumns: string[] = Object.keys(index.columns).filter(
        (c) => !(startedColumns?.includes(c) || completedColumns?.includes(c))
      )

      const tasksByColumns = await Promise.all(
        [...startedColumns, ...otherColumns, ...completedColumns].map(async (columnName) => ({
          columnName,
          tasks: await Promise.all(
            index.columns[columnName].map(async (taskId) => await kanbn.getTask(taskId))
          ),
        }))
      )

      // Create QuickPickItems for each task mangled with separators for each column
      const quickPickItems: vscode.QuickPickItem[] = tasksByColumns.flatMap((column) => [
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: column.columnName,
        },
        ...column.tasks.map((task) => ({
          label: task.name,
          detail: task.id,
        })),
      ])

      // Show QuickPick
      const qp = await vscode.window.showQuickPick(quickPickItems)
      if (qp?.detail !== undefined) {
        // Open the task using custom editor
        const taskPath = `${board}/.kanbn/tasks/${qp.detail}.md`
        const taskUri = vscode.Uri.file(taskPath)
        await vscode.commands.executeCommand('vscode.openWith', taskUri, 'kanbn.task')
      }
    })
  )

  // Register a command to open a burndown chart.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.burndown", async () => {
      const board = await chooseBoard()
      if (board === undefined) return

      // Get or create burndown panel for the board
      const burndownPanel = getBurndownPanel(board)
      const kanbn = getKanbnForBoard(board)

      // If kanbn is initialised, view the burndown chart
      burndownPanel.show()
      void burndownPanel.update()
      void kanbnStatusBarItem.update(kanbn)
    })
  )

  // Register a command to archive tasks.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.archiveTasks", async () => {
      const board = await chooseBoard()
      if (board === undefined) return

      // Get kanbn instance for the board
      const kanbn = getKanbnForBoard(board)

      // Get a list of tracked tasks
      let tasks: string[] = []
      try {
        tasks = [...(await kanbn.findTrackedTasks())]
      } catch (e) {
        console.log(e)
      }
      if (tasks.length === 0) {
        void vscode.window.showInformationMessage("There are no tasks to archive.")
        return
      }

      // Prompt for a selection of tasks to archive
      const archiveTaskIds = await vscode.window.showQuickPick(tasks, {
        placeHolder: "Select tasks to archive...",
        canPickMany: true,
      })
      if (archiveTaskIds !== undefined && archiveTaskIds.length > 0) {
        for (const archiveTaskId of archiveTaskIds) {
          void kanbn.archiveTask(archiveTaskId)
        }
        void kanbnStatusBarItem.update(kanbn)
        if (
          vscode.workspace.getConfiguration("kanbn").get<boolean>("showTaskNotifications") === true
        ) {
          void vscode.window.showInformationMessage(
            `Archived ${archiveTaskIds.length} task${archiveTaskIds.length === 1 ? "" : "s"}.`
          )
        }
      }
    })
  )

  // Register a command to restore a task from the archive.
  context.subscriptions.push(
    vscode.commands.registerCommand("kanbn.restoreTasks", async () => {
      const board = await chooseBoard()
      if (board === undefined) return
      // Get kanbn instance for the board
      const kanbn = getKanbnForBoard(board)

      // Get a list of archived tasks
      let archivedTasks: string[] = []
      try {
        archivedTasks = await kanbn.listArchivedTasks()
      } catch (e) {
        console.log(e)
      }
      if (archivedTasks.length === 0) {
        void vscode.window.showInformationMessage("There are no archived tasks to restore.")
        return
      }

      // Prompt for a selection of tasks to restore
      const restoreTaskIds = await vscode.window.showQuickPick(archivedTasks, {
        placeHolder: "Select tasks to restore...",
        canPickMany: true,
      })
      if (restoreTaskIds !== undefined && restoreTaskIds.length > 0) {
        // Load index
        const index = await kanbn.getIndex()

        // Prompt for a column to restore the tasks into
        const restoreColumn = await vscode.window.showQuickPick(
          ["None (use original)", ...Object.keys(index.columns)],
          {
            canPickMany: false,
          }
        )
        if (restoreColumn !== undefined) {
          for (const restoreTaskId of restoreTaskIds) {
            await kanbn.restoreTask(
              restoreTaskId,
              restoreColumn === "None (use original)" ? null : restoreColumn
            )
          }
          void kanbnStatusBarItem.update(kanbn)
          if (vscode.workspace.getConfiguration("kanbn").get("showTaskNotifications") === true) {
            void vscode.window.showInformationMessage(
              `Restored ${restoreTaskIds.length} task${restoreTaskIds.length === 1 ? "" : "s"}.`
            )
          }
        }
      }
    })
  )

  // Handle configuration changes.
  vscode.workspace.onDidChangeConfiguration(() => {
    populateBoardCache()
    // Configuration changed - no need to update panels since we use custom editors now
  })
}
