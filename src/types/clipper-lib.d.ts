declare module 'clipper-lib' {
	export type IntPoint = { X: number; Y: number };
	export type Path = IntPoint[];
	export type Paths = Path[];

	export class PolyNode {
		Contour(): Path;
		Childs(): PolyNode[];
		IsHole(): boolean;
	}

	export class PolyTree extends PolyNode {}

	export class Clipper {
		static Orientation(path: Path): boolean;
		AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
		Execute(
			clipType: number,
			solution: PolyTree | Paths,
			subjFillType: number,
			clipFillType: number
		): boolean;
	}

	export class ClipperOffset {
		constructor(miterLimit?: number, arcTolerance?: number);
		AddPaths(paths: Paths, joinType: number, endType: number): void;
		Execute(solution: Paths, delta: number): void;
	}

	const ClipperLib: {
		Clipper: typeof Clipper;
		ClipperOffset: typeof ClipperOffset;
		PolyTree: typeof PolyTree;
		PolyTreeToPaths: (polyTree: PolyTree) => Paths;
		ClipType: { ctUnion: number; ctDifference: number; ctIntersection: number };
		PolyType: { ptSubject: number; ptClip: number };
		PolyFillType: { pftNonZero: number };
		JoinType: { jtRound: number };
		EndType: { etClosedPolygon: number };
	};

	export default ClipperLib;
}
