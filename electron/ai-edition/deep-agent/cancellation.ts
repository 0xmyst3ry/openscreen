/** Await read-only work without requiring an uncooperative provider to settle.
 * The caller must still guard every commit after an await with throwIfAborted. */
export async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	let abort: () => void = () => undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			abort = () => reject(signal.reason);
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", abort, { once: true });
			Promise.resolve(work).then(resolve, reject);
		});
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
