import type { Line, Circle } from 'fabric';

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
    line?: Line;
}

export function generateId(): string {
    return Math.random().toString(36).substring(2, 11);
}

export class RoadGraph {
    private nodes = new Map<string, NetworkNode>();
    private segments = new Map<string, NetworkSegment>();
    private logScheduled = false;

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
    }

    getNode(id: string): NetworkNode | undefined {
        return this.nodes.get(id);
    }

    updateNode(id: string, updates: Partial<Omit<NetworkNode, 'id'>>): void {
        const node = this.nodes.get(id);
        if (node) {
            Object.assign(node, updates);
            this.scheduleLog();
        }
    }

    deleteNode(id: string): void {
        this.nodes.delete(id);
        this.scheduleLog();
    }

    addSegment(segment: NetworkSegment): void {
        this.segments.set(segment.id, segment);
        this.scheduleLog();
    }

    getSegment(id: string): NetworkSegment | undefined {
        return this.segments.get(id);
    }

    findSegmentByLine(line: Line): NetworkSegment | undefined {
        return Array.from(this.segments.values()).find(s => s.line === line);
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
    }

    getAllSegments(): Map<string, NetworkSegment> {
        return this.segments;
    }
}
