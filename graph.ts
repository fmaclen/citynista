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
        console.log('=== Road Network ===');
        console.log('Nodes:', this.nodes.size);
        this.nodes.forEach((node, id) => {
            console.log(`  ${id}: (${node.x.toFixed(1)}, ${node.y.toFixed(1)}) - ${node.connectedSegments.length} segments`);
        });
        console.log('Segments:', this.segments.size);
        this.segments.forEach((segment, id) => {
            console.log(`  ${id}: ${segment.startNodeId} -> ${segment.endNodeId}`);
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
}
