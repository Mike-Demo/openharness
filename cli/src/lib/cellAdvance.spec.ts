import { describe, expect, it } from 'vitest'
import { cellAdvance } from './cellAdvance.js'

const advance = (text: string): number[] => [...text].map((char) => cellAdvance(char.codePointAt(0)!))

describe('cellAdvance', () => {
  it('moves one column for Latin, precomposed accented letters included, two for CJK and wide emoji', () => {
    expect(advance('aZ~ ñü')).toEqual([1, 1, 1, 1, 1, 1])
    expect(advance('中文한글カ')).toEqual([2, 2, 2, 2, 2])
    expect(advance('🎉👨')).toEqual([2, 2])
  })

  // xterm.dart's Buffer.writeChar advances for every code point it is handed, whatever its wcwidth.
  it('moves one column for a combining mark, a joiner and a variation selector, as the viewers do', () => {
    expect(advance('ê')).toEqual([1, 1])
    expect(advance('‍️')).toEqual([1, 1])
  })

  it('reads the ends of the ported ranges as Unicode 11 does', () => {
    expect(advance('ჿᄀᅟᅠ')).toEqual([1, 2, 2, 1])
    expect([0x1f6fa, 0x1f6fb, 0x3fffd, 0x3fffe].map(cellAdvance)).toEqual([2, 1, 2, 1])
  })
})
