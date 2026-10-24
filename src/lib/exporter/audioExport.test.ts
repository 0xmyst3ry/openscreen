import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { isolateAudioTrack } from "./audioExport";

function track(id: string, trackId: string, muted = false): AxcutDocument["audioTracks"][number] {
	return {
		id,
		trackId,
		startMs: 0,
		endMs: 1000,
		assetId: "asset_voice",
		kind: "voiceover",
		durationSec: 1,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted,
		label: "",
		origin: "agent",
	};
}

describe("isolateAudioTrack", () => {
	const document: AxcutDocument = {
		...createEmptyDocument({ projectId: "p", title: "Demo" }),
		// "voice" is one pill split across two clips; "music" is another track.
		audioTracks: [track("a", "voice"), track("b", "voice"), track("c", "music")],
	};

	it("keeps every fragment of the asked track and nothing else", () => {
		expect(isolateAudioTrack(document, "voice").audioTracks.map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("refuses an unknown or muted track", () => {
		expect(() => isolateAudioTrack(document, "nope")).toThrow('no audio track with the id "nope"');
		const muted = { ...document, audioTracks: [track("c", "music", true)] };
		expect(() => isolateAudioTrack(muted, "music")).toThrow("is muted");
	});
});
