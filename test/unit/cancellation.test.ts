import { describe, expect, it } from 'vitest';
import { CancellationTokenSource } from 'vscode';
import { tokenToSignal } from '../../src/cancellation';

describe('tokenToSignal', () => {
	it('returns a signal that is not aborted for a fresh token', () => {
		const source = new CancellationTokenSource();

		const signal = tokenToSignal(source.token);

		expect(signal.aborted).toBe(false);
	});

	it('returns an already-aborted signal when the token is already cancelled', () => {
		const source = new CancellationTokenSource();
		source.cancel();

		const signal = tokenToSignal(source.token);

		expect(signal.aborted).toBe(true);
	});

	it('aborts the signal when the token is cancelled afterwards', () => {
		const source = new CancellationTokenSource();
		const signal = tokenToSignal(source.token);

		expect(signal.aborted).toBe(false);
		source.cancel();

		expect(signal.aborted).toBe(true);
	});

	it('produces independent signals for independent tokenToSignal calls', () => {
		const source = new CancellationTokenSource();
		const signalA = tokenToSignal(source.token);
		const signalB = tokenToSignal(source.token);

		source.cancel();

		expect(signalA.aborted).toBe(true);
		expect(signalB.aborted).toBe(true);
	});
});
