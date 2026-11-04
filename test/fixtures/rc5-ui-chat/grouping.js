// Copyright (c) 2026 DeepSeek. MIT License (the @deepseek-ai/dsh-client-ui-chat package LICENSE).
// Verbatim excerpt of the Chat grouping rule shipped in
// @deepseek-ai/dsh-client-ui-chat 0.2.1-rc.5, lib/client.js
// (sha256 fdc48656f914c503e59ed45612c09be296634bfaf5318df2ba5930566a2a8820,
// as bundled in the DeepSeek Harness desktop app 0.2.1-rc.5).
//
//   DEPTH + isAtOrOutside      lib/client.js:175-189   (group-tree.js)
//   classification loop        lib/client.js:11535-11566 (TurnGroups.rebuild)
//
// The loop's `readPosition` bookkeeping is dropped (it only flushes on a gap in
// the turn order, and the keys here are contiguous), and `flush` and `emit` are reduced to what the loop's outcome needs: the
// upstream versions also build ProcessGroup snapshots (activity counts, the
// collapsed "ran commands, called tools, read files" row), which do not decide
// WHERE a node lands. Everything that decides it is copied unchanged. A node
// that ends up inside `pending` is rendered only when that collapsed group is
// opened; on a completed turn the whole process is folded as well
// (ChatNodeSeat, lib/client.js:3733, `!isAtOrOutside(routedNode, "turn")`).
/* eslint-disable */

const DEPTH = {
	exchange: 0,
	input: 1,
	turn: 2,
	process: 3
};
function isAtOrOutside(node, position) {
	return node.groupTree !== void 0 && DEPTH[node.groupTree] <= DEPTH[position];
}

/**
 * @param {readonly string[]} turnKeys - the turn's node keys in order.
 * @param {(key: string) => any} readNode
 * @param {(node: any) => boolean} reasoning
 * @param {(node: any) => boolean} reply
 * @returns {Array<{kind: 'node', key: string, groupPart?: string} | {kind: 'group', members: string[]}>}
 */
export function groupTurn(turnKeys, readNode, reasoning = () => false, reply = () => true) {
	const roots = [];
	let pending = [];
	const flush = () => {
		if (pending.length === 0) return;
		roots.push({ kind: 'group', members: pending.map((member) => member.key) });
		pending = [];
	};
	const emit = (_key, entry) => { roots.push(entry); };
	for (const key of turnKeys) {
		const node = readNode(key);
		if (isAtOrOutside(node, "process")) {
			flush(true);
			emit(key, {
				kind: "node",
				key
			});
		} else if (node.kind === "assistant-step") {
			if (reasoning(node)) pending.push({
				kind: "node",
				key,
				groupPart: "reasoning"
			});
			if (reply(node)) {
				flush(true);
				emit(key, {
					kind: "node",
					key,
					groupPart: "response"
				});
			}
		} else pending.push({
			kind: "node",
			key
		});
	}
	flush();
	return roots;
}

export { isAtOrOutside };
