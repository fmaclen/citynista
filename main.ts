import { RoadGraph } from './graph/graph';
import { setupCanvas } from './canvas';
import { restoreGraph } from './graph/restore';

const graph = new RoadGraph();
const canvas = setupCanvas(graph);

// Load saved graph from localStorage
const savedData = RoadGraph.load();
if (savedData) {
    restoreGraph(graph, canvas, savedData);
}
