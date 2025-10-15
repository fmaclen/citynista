import type { Path, Circle } from 'fabric';

export interface NetworkNode {
    id: string;
    x: number;
    y: number;
    connectedSegments: string[];
    circle?: Circle;
}

export interface NetworkSegment {
    id: string;
    startNodeId: string;
    endNodeId: string;
    path?: Path;
    controlX: number;
    controlY: number;
}

export function generateId(): string {
    return Math.random().toString(36).substring(2, 11);
}

export interface SerializedNode {
    id: string;
    x: number;
    y: number;
    connectedSegments: string[];
}

export interface SerializedSegment {
    id: string;
    startNodeId: string;
    endNodeId: string;
    controlX: number;
    controlY: number;
}

export interface SerializedGraph {
    nodes: SerializedNode[];
    segments: SerializedSegment[];
}

export class RoadGraph {
    private nodes = new Map<string, NetworkNode>();
    private segments = new Map<string, NetworkSegment>();
    private logScheduled = false;
    private saveScheduled = false;
    private static STORAGE_KEY = 'citynista-graph';

    private scheduleLog(): void {
        if (this.logScheduled) return;
        this.logScheduled = true;
        requestAnimationFrame(() => {
            this.log();
            this.logScheduled = false;
        });
    }

    log(): void {
        const nodesData: Record<string, any> = {};
        this.nodes.forEach((node, id) => {
            nodesData[id] = {
                coords: `(${node.x.toFixed(1)}, ${node.y.toFixed(1)})`,
                segments: node.connectedSegments
            };
        });

        const segmentsData: Record<string, any> = {};
        this.segments.forEach((segment, id) => {
            const startNode = this.nodes.get(segment.startNodeId);
            const endNode = this.nodes.get(segment.endNodeId);
            segmentsData[id] = {
                from: startNode ? `${segment.startNodeId}: (${startNode.x.toFixed(1)}, ${startNode.y.toFixed(1)})` : segment.startNodeId,
                to: endNode ? `${segment.endNodeId}: (${endNode.x.toFixed(1)}, ${endNode.y.toFixed(1)})` : segment.endNodeId
            };
        });

        console.log(`Road Network - Nodes: ${this.nodes.size}, Segments: ${this.segments.size}`, {
            nodes: nodesData,
            segments: segmentsData
        });
    }

    addNode(node: NetworkNode): void {
        this.nodes.set(node.id, node);
        this.scheduleLog();
        this.scheduleSave();
    }

    getNode(id: string): NetworkNode | undefined {
        return this.nodes.get(id);
    }

    updateNode(id: string, updates: Partial<Omit<NetworkNode, 'id'>>): void {
        const node = this.nodes.get(id);
        if (node) {
            Object.assign(node, updates);
            this.scheduleLog();
            this.scheduleSave();
        }
    }

    deleteNode(id: string): void {
        this.nodes.delete(id);
        this.scheduleLog();
        this.scheduleSave();
    }

    addSegment(segment: NetworkSegment): void {
        this.segments.set(segment.id, segment);
        this.scheduleLog();
        this.scheduleSave();
    }

    getSegment(id: string): NetworkSegment | undefined {
        return this.segments.get(id);
    }

    updateSegment(id: string, updates: Partial<Omit<NetworkSegment, 'id'>>): void {
        const segment = this.segments.get(id);
        if (segment) {
            Object.assign(segment, updates);
            this.scheduleSave();
        }
    }

    findSegmentByPath(path: Path): NetworkSegment | undefined {
        return Array.from(this.segments.values()).find(s => s.path === path);
    }

    findNearbyNode(x: number, y: number, threshold: number = 15): NetworkNode | undefined {
        for (const node of this.nodes.values()) {
            const dx = node.x - x;
            const dy = node.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= threshold) {
                return node;
            }
        }
        return undefined;
    }

    deleteSegment(id: string): void {
        this.segments.delete(id);
        this.scheduleLog();
        this.scheduleSave();
    }

    getAllSegments(): Map<string, NetworkSegment> {
        return this.segments;
    }

    getAllNodes(): Map<string, NetworkNode> {
        return this.nodes;
    }

    private scheduleSave(): void {
        if (this.saveScheduled) return;
        this.saveScheduled = true;
        requestAnimationFrame(() => {
            this.save();
            this.saveScheduled = false;
        });
    }

    serialize(): SerializedGraph {
        const nodes: SerializedNode[] = [];
        this.nodes.forEach(node => {
            nodes.push({
                id: node.id,
                x: node.x,
                y: node.y,
                connectedSegments: [...node.connectedSegments]
            });
        });

        const segments: SerializedSegment[] = [];
        this.segments.forEach(segment => {
            segments.push({
                id: segment.id,
                startNodeId: segment.startNodeId,
                endNodeId: segment.endNodeId,
                controlX: segment.controlX,
                controlY: segment.controlY
            });
        });

        return { nodes, segments };
    }

    save(): void {
        try {
            const data = this.serialize();
            localStorage.setItem(RoadGraph.STORAGE_KEY, JSON.stringify(data));
        } catch (error) {
            console.error('Failed to save graph to localStorage:', error);
        }
    }

    static load(): SerializedGraph | null {
        try {
            const data = localStorage.getItem(RoadGraph.STORAGE_KEY);
            if (!data) return null;
            return JSON.parse(data);
        } catch (error) {
            console.error('Failed to load graph from localStorage:', error);
            return null;
        }
    }

    clear(): void {
        this.nodes.clear();
        this.segments.clear();
        this.scheduleSave();
        this.scheduleLog();
    }
}
