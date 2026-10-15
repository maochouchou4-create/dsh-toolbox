/**
 * 宿主包 dsh-llm 的替身（装配层冒烟用）：see-image 从这里导入 BlockAssembler。
 *
 * 方法面照着真宿主那份（`@deepseek-ai/dsh-llm` 的 lib/index.js 里 `var BlockAssembler = class`）：
 * `push(chunk)`、`ensure(index, blockType)`、`blocks()` 方法、`finish` 取值器（缺省
 * `{ kind: 'stop' }`），外加 `usage`／`replayState` 两个取值器。**这一层必须逐字对得上**：
 * vision.js 只认「能 push(chunk)、交得出 finish 与 blocks()」这一个形状，替身若给的是 add()／
 * blocks 属性／text 取值器（此前那版给的正是这三个），任何真正走到消费面的用例都会在第一条
 * chunk 上炸，而报错指向的是 lib 而不是替身。
 *
 * 攒块语义与真宿主逐条对拍，**覆盖范围＝vision.js 消费面用到的那几种 chunk**：delta 裸来时按
 * delta 种类自动建块（真宿主的 ensure）、block-end 的整块优先于此前累积的 text、不认识的类型
 * 当场抛（真宿主的 assertNever）。三条各有一条用例在 test/dispatch-assembly.test.js 里对着真
 * 语义打。
 *
 * delta 侧那条「已收尾即 return」的守卫照抄了宿主，但它在这条消费面上**不可观测**——宿主那边
 * 同样不可观测（已收尾时 blocks() 交出的是那一整块，去掉守卫输出逐字不变，实测过）。它防的是
 * 畸形流把半成品撑大，属内部状态那一层。故对拍③ 钉的是「整块优先于累积 text」这个可观测事实，
 * 不是守卫本身。
 *
 * **不由本替身作证的部分**：block-start 的完整协议（真宿主按它记块类型与到达次序的那几档）、
 * tool-call 组装、max-tokens 剪枝、replayState 修剪——那些没有用例钉着。这里不是宿主攒块器的
 * 复刻，而是消费面那一小段的同形件。
 */
export class BlockAssembler {
	#partials = new Map()

	#order = []

	#usage = undefined

	#finish = undefined

	/**
	 * 喂一个 chunk。对没开过块的 index 是自动建块而非丢弃（真宿主 ensure）：delta-only 协议下
	 * 丢弃即正文恒空，而症状是「视觉模型明明回了字、转述却是空正文」。
	 */
	push(chunk) {
		switch (chunk.type) {
			case 'block-start':
				if (!this.#partials.has(chunk.index)) {
					this.#order.push(chunk.index)
					this.#partials.set(chunk.index, { blockType: chunk.blockType, text: '', block: undefined })
				}
				return
			case 'text-delta':
			case 'reasoning-delta': {
				const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
				if (partial.block !== undefined) return
				partial.text += chunk.text
				return
			}
			case 'block-end': {
				const partial = this.ensure(chunk.index, chunk.block.type)
				if (partial.block !== undefined) return
				partial.block = chunk.block
				return
			}
			case 'usage':
				this.#usage = chunk.usage
				return
			case 'finish':
				this.#finish = chunk.reason
				return
			default:
				throw new Error(`BlockAssembler.push 收到替身不认识的 chunk 类型：${JSON.stringify(chunk)}——真宿主那一侧是 assertNever，吞掉的话协议漂移无声，症状是转述少一段而不是报错`)
		}
	}

	/** 取某 index 的半成品，没有就建一份（块类型由调用方按 delta 种类或整块定）。 */
	ensure(index, blockType) {
		const existing = this.#partials.get(index)
		if (existing !== undefined) return existing
		const partial = { blockType, text: '', block: undefined }
		this.#partials.set(index, partial)
		this.#order.push(index)
		return partial
	}

	/** 按见到次序交出已攒的块；block-end 带来的整块以它为准（真宿主 assemble 那一步的同形）。 */
	blocks() {
		return this.#order.flatMap((index) => {
			const partial = this.#partials.get(index)
			return [partial.block ?? { type: partial.blockType, text: partial.text }]
		})
	}

	get usage() {
		return this.#usage
	}

	get finish() {
		return this.#finish ?? { kind: 'stop' }
	}

	get replayState() {
		return undefined
	}
}
