import * as vscode from 'vscode'
import type {
    WorkflowFromExtension,
    WorkflowToExtension,
} from '../../webviews/workflow/services/WorkflowProtocol'

import type { ChatClient } from '@sourcegraph/cody-shared'
import { executeWorkflow } from './workflow-executor'
import { handleWorkflowLoad, handleWorkflowSave } from './workflow-io'

/**
 * Registers the Cody workflow commands in the Visual Studio Code extension context.
 *
 * This function sets up the necessary event handlers and message handlers for the Cody workflow editor webview panel.
 * It allows users to open the workflow editor, save the current workflow, load a previously saved workflow, and execute the current workflow.
 *
 * @param context - The Visual Studio Code extension context.
 * @param chatClient - The Cody chat client for executing the workflow.
 * @returns void
 */
export function registerWorkflowCommands(context: vscode.ExtensionContext, chatClient: ChatClient) {
    let activeAbortController: AbortController | null = null
    context.subscriptions.push(
        vscode.commands.registerCommand('cody.openWorkflowEditor', async () => {
            const panel = vscode.window.createWebviewPanel(
                'codyWorkflow',
                'Cody Workflow Editor',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
                }
            )

            // Handler for message from the webview
            panel.webview.onDidReceiveMessage(
                async (message: WorkflowToExtension) => {
                    switch (message.type) {
                        case 'save_workflow':
                            await handleWorkflowSave(message.data)
                            break
                        case 'load_workflow': {
                            const loadedData = await handleWorkflowLoad()
                            if (loadedData) {
                                panel.webview.postMessage({
                                    type: 'workflow_loaded',
                                    data: loadedData,
                                } as WorkflowFromExtension)
                            }
                            break
                        }
                        case 'execute_workflow': {
                            if (message.data?.nodes && message.data?.edges) {
                                activeAbortController = new AbortController()
                                try {
                                    await executeWorkflow(
                                        message.data?.nodes || [],
                                        message.data?.edges || [],
                                        panel.webview,
                                        chatClient,
                                        activeAbortController.signal
                                    )
                                } finally {
                                    activeAbortController = null
                                }
                            }
                            break
                        }
                        case 'abort_workflow':
                            if (activeAbortController) {
                                activeAbortController.abort()
                                activeAbortController = null
                            }
                            break
                    }
                },
                undefined,
                context.subscriptions
            )

            // Clean Up
            panel.onDidDispose(() => {
                if (activeAbortController) {
                    activeAbortController.abort()
                    activeAbortController = null
                }
                panel.dispose()
            })

            const webviewPath = vscode.Uri.joinPath(context.extensionUri, 'dist/webviews')

            // Read the HTML file content
            const root = vscode.Uri.joinPath(webviewPath, 'workflow.html')
            const bytes = await vscode.workspace.fs.readFile(root)
            const decoded = new TextDecoder('utf-8').decode(bytes)
            const resources = panel.webview.asWebviewUri(webviewPath)

            // Replace variables in the HTML content
            panel.webview.html = decoded
                .replaceAll('./', `${resources.toString()}/`)
                .replaceAll('{cspSource}', panel.webview.cspSource)
        })
    )
}
