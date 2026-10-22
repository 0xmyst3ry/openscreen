import { type AgentDocumentApplyResult, applyAgentDocumentIfCurrent } from "./agentDocumentApply";
import { useProjectStore } from "./projectStore";

/** Serialises completed tool edits through the existing save/undo boundary.
 * Finishing a turn drains these writes; abandoning its panel discards queued edits.
 * Never reapply the final aggregate after individual edits have reached history. */
export class AgentDocumentStream {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly pending: unknown[] = [];
	private revision: number;
	private readonly projectId: string | null;
	private readonly hasDocument: boolean;
	seen = false;
	failure: AgentDocumentApplyResult | null = null;

	constructor() {
		const state = useProjectStore.getState();
		this.revision = state.revision;
		this.projectId = state.projectId;
		this.hasDocument = state.document !== null;
	}

	push(document: unknown): void {
		if (this.closed) return;
		this.seen = true;
		this.queue = this.queue
			.then(async () => {
				if (this.closed) return;
				if (this.failure) {
					this.pending.push(document);
					return;
				}
				if (!this.hasDocument || useProjectStore.getState().projectId !== this.projectId) {
					this.failure = "no-live-document";
					return;
				}
				const applying = applyAgentDocumentIfCurrent(document, this.revision);
				// An applied edit bumps once for its optimistic setDocument and once for
				// its save. A manual edit/undo during that save remains a conflict for
				// the NEXT tool too; don't adopt an unrelated new revision as our own.
				const result = await applying;
				if (result === "applied") this.revision += 2;
				else {
					this.failure = result;
					this.pending.push(document);
				}
			})
			.catch(() => {
				this.failure = "save-failed";
			});
	}

	/** Explicit user consent to apply the remaining edits over a conflicting revision. */
	async applyRemaining(): Promise<void> {
		if (useProjectStore.getState().projectId !== this.projectId) return;
		this.revision = useProjectStore.getState().revision;
		this.failure = null;
		this.closed = false;
		for (const document of this.pending.splice(0)) this.push(document);
		await this.finish();
	}

	close(): void {
		this.closed = true;
	}

	async finish(): Promise<void> {
		await this.queue;
		this.close();
	}
}
