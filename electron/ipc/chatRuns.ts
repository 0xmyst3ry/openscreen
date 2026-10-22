/** Main-process ownership of agent turns. One writer per project, even across windows. */
export class ChatRuns<Owner> {
	private readonly projects = new Map<
		string,
		{
			owner: Owner;
			sessionId: string;
			runId: string;
			controller: AbortController;
		}
	>();

	start(owner: Owner, projectId: string, sessionId: string, runId: string) {
		if (this.projects.has(projectId)) return null;
		const turn = { owner, sessionId, runId, controller: new AbortController() };
		this.projects.set(projectId, turn);
		return {
			signal: turn.controller.signal,
			finish: () => {
				if (this.projects.get(projectId) === turn) this.projects.delete(projectId);
				// Detached tools must stay sealed after all exit paths.
				turn.controller.abort();
			},
		};
	}

	cancel(owner: Owner, projectId: string, sessionId: string, runId: string): boolean {
		const turn = this.projects.get(projectId);
		if (!turn || turn.owner !== owner || turn.sessionId !== sessionId || turn.runId !== runId) {
			return false;
		}
		turn.controller.abort();
		return true;
	}
}
