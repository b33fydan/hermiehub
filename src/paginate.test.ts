import { describe, it, expect } from 'vitest'
import { paginate } from './paginate'

const opts = { maxLineChars: 38, maxLines: 5 }

describe('paginate', () => {
  it('keeps short content as a single page', () => {
    expect(paginate('hello\nworld', opts)).toEqual(['hello\nworld'])
  })

  it('splits into pages of maxLines', () => {
    expect(paginate('l1\nl2\nl3\nl4\nl5\nl6\nl7', opts)).toEqual(['l1\nl2\nl3\nl4\nl5', 'l6\nl7'])
  })

  it('word-wraps a long line to the width', () => {
    expect(paginate('alpha bravo charlie delta', { maxLineChars: 12, maxLines: 5 }))
      .toEqual(['alpha bravo\ncharlie\ndelta'])
  })

  it('hard-splits a word longer than the width', () => {
    expect(paginate('abcdefghij', { maxLineChars: 4, maxLines: 5 }))
      .toEqual(['abcd\nefgh\nij'])
  })

  it('returns a single empty page for empty text', () => {
    expect(paginate('', opts)).toEqual([''])
  })
})
