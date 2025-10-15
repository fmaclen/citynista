export interface OSMNode {
	id: string;
	lat: number;
	lon: number;
}

export interface OSMWay {
	id: string;
	nodes: OSMNode[];
	tags: Record<string, string>;
}

export interface OSMData {
	ways: OSMWay[];
	bounds: {
		minLat: number;
		maxLat: number;
		minLon: number;
		maxLon: number;
	};
}

export function parseOSMXML(xmlString: string): OSMData {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlString, 'text/xml');

	const nodeMap = new Map<string, OSMNode>();
	const ways: OSMWay[] = [];

	const boundsEl = doc.querySelector('bounds');
	const bounds = {
		minLat: parseFloat(boundsEl?.getAttribute('minlat') || '0'),
		maxLat: parseFloat(boundsEl?.getAttribute('maxlat') || '0'),
		minLon: parseFloat(boundsEl?.getAttribute('minlon') || '0'),
		maxLon: parseFloat(boundsEl?.getAttribute('maxlon') || '0')
	};

	doc.querySelectorAll('way').forEach((wayEl) => {
		const wayId = wayEl.getAttribute('id') || '';
		const nodes: OSMNode[] = [];
		const tags: Record<string, string> = {};

		wayEl.querySelectorAll('nd').forEach((ndEl) => {
			const ref = ndEl.getAttribute('ref') || '';
			const lat = parseFloat(ndEl.getAttribute('lat') || '0');
			const lon = parseFloat(ndEl.getAttribute('lon') || '0');

			if (!nodeMap.has(ref)) {
				nodeMap.set(ref, { id: ref, lat, lon });
			}
			nodes.push(nodeMap.get(ref)!);
		});

		wayEl.querySelectorAll('tag').forEach((tagEl) => {
			const k = tagEl.getAttribute('k') || '';
			const v = tagEl.getAttribute('v') || '';
			tags[k] = v;
		});

		if (nodes.length > 0) {
			ways.push({ id: wayId, nodes, tags });
		}
	});

	return { ways, bounds };
}

export function latLonToCanvas(
	lat: number,
	lon: number,
	bounds: OSMData['bounds'],
	canvasWidth: number,
	canvasHeight: number
): { x: number; y: number } {
	const latRange = bounds.maxLat - bounds.minLat;
	const lonRange = bounds.maxLon - bounds.minLon;

	const padding = 50;
	const usableWidth = canvasWidth - 2 * padding;
	const usableHeight = canvasHeight - 2 * padding;

	const x = padding + ((lon - bounds.minLon) / lonRange) * usableWidth;
	const y = canvasHeight - padding - ((lat - bounds.minLat) / latRange) * usableHeight;

	return { x, y };
}

export async function fetchOSMData(
	minLat: number,
	minLon: number,
	maxLat: number,
	maxLon: number
): Promise<OSMData> {
	const query = `[bbox:${minLat},${minLon},${maxLat},${maxLon}];way["highway"];out geom;`;

	const response = await fetch('https://overpass-api.de/api/interpreter', {
		method: 'POST',
		body: new URLSearchParams({ data: query })
	});

	const xmlString = await response.text();
	return parseOSMXML(xmlString);
}
