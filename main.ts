import { RoadGraph } from './graph/graph';
import { setupCanvas } from './canvas';
import { restoreGraph } from './graph/restore';
import { fetchOSMData } from './osm/import';
import { importOSMToGraph } from './osm/import-to-graph';

const graph = new RoadGraph();
const canvas = setupCanvas(graph);

// Load saved graph from localStorage
const savedData = RoadGraph.load();
if (savedData) {
	restoreGraph(graph, canvas, savedData);
}

async function loadOSMSample() {
	const osmData = await fetchOSMData(25.618, -80.3465, 25.62, -80.344);

	console.log('Loaded OSM data:', osmData);

	importOSMToGraph(osmData, graph, canvas);
}

const loadButton = document.createElement('button');
loadButton.textContent = 'Load OSM Sample';
loadButton.style.position = 'absolute';
loadButton.style.top = '10px';
loadButton.style.left = '10px';
loadButton.style.zIndex = '1000';
loadButton.style.padding = '8px 16px';
loadButton.style.cursor = 'pointer';
loadButton.onclick = () => loadOSMSample();
document.body.appendChild(loadButton);
