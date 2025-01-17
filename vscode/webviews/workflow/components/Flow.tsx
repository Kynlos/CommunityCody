import {
    Background,
    Controls,
    type EdgeChange,
    type NodeChange,
    ReactFlow,
    addEdge,
    applyEdgeChanges,
    applyNodeChanges,
    useOnSelectionChange,
    useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GenericVSCodeWrapper } from '@sourcegraph/cody-shared'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkflowFromExtension, WorkflowToExtension } from '../services/WorkflowProtocol'
import { CustomOrderedEdge, type Edge } from './CustomOrderedEdge'
import { WorkflowSidebar } from './WorkflowSidebar'
import { NodeType, type WorkflowNode, createNode, defaultWorkflow, nodeTypes } from './nodes/Nodes'

export const Flow: React.FC<{
    vscodeAPI: GenericVSCodeWrapper<WorkflowToExtension, WorkflowFromExtension>
}> = ({ vscodeAPI }) => {
    const { getViewport } = useReactFlow()
    const [nodes, setNodes] = useState(defaultWorkflow.nodes)
    const [edges, setEdges] = useState(defaultWorkflow.edges)
    const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null)
    const [movingNodeId, setMovingNodeId] = useState<string | null>(null)
    const [executingNodeId, setExecutingNodeId] = useState<string | null>(null)
    const [nodeErrors, setNodeErrors] = useState<Map<string, string>>(new Map())
    const [edgeOrder, setEdgeOrder] = useState<Map<string, number>>(new Map())
    const [isExecuting, setIsExecuting] = useState(false)

    const [sidebarWidth, setSidebarWidth] = useState(256) // 256px is original width (tw-w-64)
    const [isResizing, setIsResizing] = useState(false)
    const [startX, setStartX] = useState(0)
    const [startWidth, setStartWidth] = useState(0)
    const [abortController, setAbortController] = useState<AbortController | null>(null)

    const edgeTypes = {
        'ordered-edge': CustomOrderedEdge,
    }

    // Add message handler for loaded workflows
    useEffect(() => {
        const messageHandler = (event: MessageEvent<WorkflowFromExtension>) => {
            if (event.data.type === 'workflow_loaded' && event.data.data) {
                setNodes(event.data.data.nodes)
                setEdges(event.data.data.edges)
            }
        }

        window.addEventListener('message', messageHandler)
        return () => window.removeEventListener('message', messageHandler)
    }, [])

    // 1. Node Operations
    // Handles all node-related state changes and updates
    // Modify the onNodesChange callback
    const onNodesChange = useCallback(
        (changes: NodeChange[]) => {
            const dragChange = changes.find(
                change => change.type === 'position' && 'dragging' in change && change.dragging
            ) as
                | {
                      id: string
                      type: 'position'
                      dragging: boolean
                      position?: { x: number; y: number }
                      event?: MouseEvent
                  }
                | undefined

            // Only handle shift-drag cloning if we haven't already created a clone
            if (dragChange?.event?.shiftKey && dragChange.dragging && !movingNodeId) {
                // Remove this block since we're handling clone creation in onNodeDragStart
                return
            }

            if (dragChange) {
                setMovingNodeId(dragChange.id)
            } else if (movingNodeId) {
                setMovingNodeId(null)
            }

            const updatedNodes = applyNodeChanges(changes, nodes) as typeof nodes
            setNodes(updatedNodes)

            if (selectedNode) {
                const updatedSelectedNode = updatedNodes.find(
                    (node: { id: string }) => node.id === selectedNode.id
                )
                setSelectedNode(updatedSelectedNode || null)
            }
        },
        [selectedNode, nodes, movingNodeId]
    )

    const onNodeDragStart = useCallback((event: React.MouseEvent, node: WorkflowNode) => {
        if (event.shiftKey) {
            // Create new node with offset position where the drag started
            const newNode = createNode(node.type, node.data.label, {
                x: node.position.x,
                y: node.position.y,
            })

            // Copy over the specific data based on node type
            if (node.type === NodeType.CLI) {
                newNode.data.command = node.data.command
            } else if (node.type === NodeType.LLM) {
                newNode.data.prompt = node.data.prompt
            } else if (node.type === NodeType.PREVIEW || node.type === NodeType.INPUT) {
                newNode.data.content = node.data.content
            }

            // Add the new node and set it as the moving node
            setNodes(current => [...current, newNode])
            setMovingNodeId(newNode.id)

            // Stop the original node from being dragged
            event.stopPropagation()
        }
    }, [])

    const onNodeClick = useCallback((event: React.MouseEvent, node: WorkflowNode) => {
        // Stop event propagation to prevent triggering background click
        event.stopPropagation()
        setSelectedNode(node)
    }, [])

    const onNodeUpdate = useCallback(
        (nodeId: string, data: Partial<WorkflowNode['data']>) => {
            setNodes(currentNodes =>
                currentNodes.map(node => {
                    if (node.id === nodeId) {
                        const updatedNode = {
                            ...node,
                            data: { ...node.data, ...data },
                        }
                        if (selectedNode?.id === nodeId) {
                            setSelectedNode(updatedNode)
                        }
                        return updatedNode
                    }
                    return node
                })
            )
        },
        [selectedNode]
    )

    const handleAddNode = useCallback(
        (nodeLabel: string, nodeType: NodeType) => {
            const { x, y, zoom } = getViewport()
            const position = { x: -x / 2 + 100 * zoom, y: -y / 2 + 100 * zoom }
            const newNode = createNode(nodeType, nodeLabel, position)
            if (nodeType === NodeType.PREVIEW || nodeType === NodeType.INPUT) {
                newNode.data.content = ''
            }
            setNodes(nodes => [...nodes, newNode])
        },
        [getViewport]
    )

    const onExecute = useCallback(() => {
        // Validate all nodes have required fields
        const invalidNodes = nodes.filter(node => {
            if (node.type === NodeType.LLM) {
                return !node.data.prompt || node.data.prompt.trim() === ''
            }
            return false
        })

        if (invalidNodes.length > 0) {
            // Update error states for invalid nodes
            const newErrors = new Map<string, string>()
            for (const node of invalidNodes) {
                const errorMessage =
                    node.type === NodeType.CLI ? 'Command field is required' : 'Prompt field is required'
                newErrors.set(node.id, errorMessage)
            }
            setNodeErrors(newErrors)
            return
        }

        // Clear any existing errors before executing
        setNodeErrors(new Map())

        const controller = new AbortController()
        setAbortController(controller)

        vscodeAPI.postMessage({
            type: 'execute_workflow',
            data: {
                nodes,
                edges,
            },
        })
    }, [nodes, edges, vscodeAPI])

    const onAbort = useCallback(() => {
        if (abortController) {
            abortController.abort()
            setAbortController(null)
            vscodeAPI.postMessage({
                type: 'abort_workflow',
            })
        }
    }, [abortController, vscodeAPI])

    // 2. Edge Operations
    // Manages connections between nodes
    const onEdgesChange = useCallback(
        (changes: EdgeChange[]) =>
            setEdges(eds => applyEdgeChanges(changes, eds) as typeof defaultWorkflow.edges),
        []
    )

    const onConnect = useCallback((params: any) => setEdges(eds => addEdge(params, eds)), [])

    const updateEdgeOrder = useCallback(() => {
        const sortedNodes = topologicalEdgeSort(nodes, edges)
        const orderMap = new Map<string, number>()

        let sequentialNumber = 1

        // Process edges following the topological order of nodes
        for (const node of sortedNodes) {
            // Find all edges that start from this node
            const sourceEdges = edges.filter(edge => edge.source === node.id)

            // Assign sequential numbers to each edge
            for (const edge of sourceEdges) {
                orderMap.set(edge.id, sequentialNumber++)
            }
        }

        setEdgeOrder(orderMap)
    }, [nodes, edges])

    useEffect(() => {
        updateEdgeOrder()
    }, [updateEdgeOrder])

    const edgesWithOrder = useMemo(
        () =>
            edges.map(edge => ({
                ...edge,
                type: 'ordered-edge',
                data: {
                    orderNumber: edgeOrder.get(edge.id) || 0,
                },
            })),
        [edges, edgeOrder]
    )

    // 3. Selection Management
    // Handles node selection state
    useOnSelectionChange({
        onChange: ({ nodes }) => {
            if (nodes.length === 0) {
                setSelectedNode(null)
            }
        },
    })

    // 4. Background/System Operations
    // Manages workspace interactions
    const handleBackgroundClick = useCallback((event: React.MouseEvent | React.KeyboardEvent) => {
        if (event.type === 'click' || (event as React.KeyboardEvent).key === 'Enter') {
            setSelectedNode(null)
        }
    }, [])

    const handleBackgroundKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter') {
            setSelectedNode(null)
        }
    }, [])

    // 5. State Transformations
    // Transforms data for rendering
    const [nodeResults, setNodeResults] = useState<Map<string, string>>(new Map())

    const nodesWithState = useMemo(
        () =>
            nodes.map(node => ({
                ...node,
                selected: node.id === selectedNode?.id,
                data: {
                    ...node.data,
                    moving: node.id === movingNodeId,
                    executing: node.id === executingNodeId,
                    error: nodeErrors.has(node.id),
                    result: nodeResults.get(node.id),
                },
            })),
        [nodes, selectedNode, movingNodeId, executingNodeId, nodeErrors, nodeResults]
    )

    const onSave = useCallback(() => {
        const workflowData = {
            nodes,
            edges,
            version: '1.0.0', // Add versioning for future compatibility
        }
        vscodeAPI.postMessage({
            type: 'save_workflow',
            data: workflowData,
        })
    }, [nodes, edges, vscodeAPI])

    const onLoad = useCallback(() => {
        vscodeAPI.postMessage({
            type: 'load_workflow',
        })
    }, [vscodeAPI])

    const onClear = useCallback(() => {
        setNodes([])
        setEdges([])
        setNodeErrors(new Map())
        setNodeResults(new Map())
        setSelectedNode(null)
        setExecutingNodeId(null)
    }, [])

    useEffect(() => {
        const messageHandler = (event: MessageEvent<WorkflowFromExtension>) => {
            switch (event.data.type) {
                case 'workflow_loaded':
                    if (event.data.data) {
                        setNodes(event.data.data.nodes)
                        setEdges(event.data.data.edges)
                        // Clear error states when loading new workflow
                        setNodeErrors(new Map())
                    }
                    break
                case 'node_execution_status':
                    if (event.data.data?.nodeId && event.data.data?.status) {
                        if (event.data.data.status === 'running') {
                            setExecutingNodeId(event.data.data.nodeId)
                            // Clear error state when node starts running
                            setNodeErrors(prev => {
                                const updated = new Map(prev)
                                updated.delete(event.data.data?.nodeId ?? '')
                                return updated
                            })
                        } else if (event.data.data.status === 'error') {
                            setExecutingNodeId(null)
                            // Set error state and message
                            setNodeErrors(prev =>
                                new Map(prev).set(
                                    event.data.data?.nodeId ?? '',
                                    event.data.data?.result ?? ''
                                )
                            )
                        } else if (event.data.data.status === 'completed') {
                            setExecutingNodeId(null)
                            const node = nodes.find(n => n.id === event.data.data?.nodeId)
                            if (node?.type === NodeType.PREVIEW) {
                                onNodeUpdate(node.id, { content: event.data.data?.result })
                            }
                        } else {
                            setExecutingNodeId(null)
                        }
                        setNodeResults(prev =>
                            new Map(prev).set(
                                event.data.data?.nodeId ?? '',
                                event.data.data?.result ?? ''
                            )
                        )
                    }
                    break
                case 'execution_started':
                    setIsExecuting(true)
                    break
                case 'execution_completed':
                    setIsExecuting(false)
                    break
            }
        }

        window.addEventListener('message', messageHandler)
        return () => window.removeEventListener('message', messageHandler)
    }, [nodes, onNodeUpdate])

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            setIsResizing(true)
            setStartX(e.clientX)
            setStartWidth(sidebarWidth)
            e.preventDefault()
        },
        [sidebarWidth]
    )

    const handleMouseMove = useCallback(
        (e: MouseEvent) => {
            if (!isResizing) return
            const delta = e.clientX - startX
            const newWidth = Math.min(Math.max(startWidth + delta, 200), 600)
            setSidebarWidth(newWidth)
        },
        [isResizing, startX, startWidth]
    )

    const handleMouseUp = useCallback(() => {
        setIsResizing(false)
    }, [])

    useEffect(() => {
        if (isResizing) {
            document.addEventListener('mousemove', handleMouseMove)
            document.addEventListener('mouseup', handleMouseUp)
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }
    }, [isResizing, handleMouseMove, handleMouseUp])

    return (
        <div className="tw-flex tw-h-screen tw-border-2 tw-border-solid tw-border-[var(--vscode-panel-border)]">
            <div
                style={{ width: sidebarWidth + 'px', flexShrink: 0 }}
                className="tw-border-r tw-border-solid tw-border-[var(--vscode-panel-border)] tw-bg-[var(--vscode-sideBar-background)]"
            >
                <WorkflowSidebar
                    onNodeAdd={handleAddNode}
                    selectedNode={selectedNode}
                    onNodeUpdate={onNodeUpdate}
                    onSave={onSave}
                    onLoad={onLoad}
                    onExecute={onExecute}
                    onClear={onClear}
                    isExecuting={isExecuting}
                    onAbort={onAbort}
                />
            </div>
            <div
                className="tw-w-2 hover:tw-w-2 tw-bg-[var(--vscode-panel-border)] hover:tw-bg-[var(--vscode-textLink-activeForeground)] tw-cursor-ew-resize tw-select-none tw-transition-colors tw-transition-width tw-shadow-sm"
                onMouseDown={handleMouseDown}
            />
            <div
                className="tw-flex-1 tw-bg-[var(--vscode-editor-background)] tw-shadow-inner"
                onClick={handleBackgroundClick}
                onKeyDown={handleBackgroundKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className="tw-w-full tw-h-full tw-border-l tw-border-solid tw-border-[var(--vscode-panel-border)]">
                    <ReactFlow
                        nodes={nodesWithState}
                        edges={edgesWithOrder}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeClick={onNodeClick}
                        onNodeDragStart={onNodeDragStart}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        fitView
                    >
                        <Background />
                        <Controls />
                    </ReactFlow>
                </div>
            </div>
        </div>
    )
}

/**
 * Performs a topological sort of the given workflow nodes and edges, returning the nodes in a sorted order.
 *
 * The topological sort ensures that nodes with no dependencies are placed first, and the order of the sorted nodes
 * respects the edges between them. This is useful for ensuring that the workflow execution order is correct.
 *
 * @param nodes - The workflow nodes to sort.
 * @param edges - The edges between the workflow nodes.
 * @returns The workflow nodes in a sorted order.
 */
function topologicalEdgeSort(nodes: WorkflowNode[], edges: Edge[]): WorkflowNode[] {
    const graph = new Map<string, string[]>()
    const inDegree = new Map<string, number>()

    // Initialize
    for (const node of nodes) {
        graph.set(node.id, [])
        inDegree.set(node.id, 0)
    }

    // Build graph
    for (const edge of edges) {
        graph.get(edge.source)?.push(edge.target)
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
    }

    // Find nodes with no dependencies but sort them based on their edge connections
    const sourceNodes = nodes.filter(node => inDegree.get(node.id) === 0)

    // Sort source nodes based on edge order
    const sortedSourceNodes = sourceNodes.sort((a, b) => {
        const aEdgeIndex = edges.findIndex(edge => edge.source === a.id)
        const bEdgeIndex = edges.findIndex(edge => edge.source === b.id)
        return aEdgeIndex - bEdgeIndex
    })

    const queue = sortedSourceNodes.map(node => node.id)
    const result: string[] = []

    while (queue.length > 0) {
        const nodeId = queue.shift()!
        result.push(nodeId)

        const neighbors = graph.get(nodeId)
        if (neighbors) {
            for (const neighbor of neighbors) {
                inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1)
                if (inDegree.get(neighbor) === 0) {
                    queue.push(neighbor)
                }
            }
        }
    }

    return result.map(id => nodes.find(node => node.id === id)!).filter(Boolean)
}
