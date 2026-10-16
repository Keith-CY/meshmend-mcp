import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePath, formatOf } from '../src/files';
import { countOpenBoundaries } from '../src/meshtools';
import { demoMesh } from '../src/core/mesh';

describe('paths', () => {
  test('~ expands to the home folder', () => {
    expect(resolvePath('~/prints/part.stl')).toBe(join(homedir(), 'prints', 'part.stl'));
    expect(resolvePath('~')).toBe(homedir());
  });
  test('relative paths resolve from the working directory; absolute paths are normalised', () => {
    expect(resolvePath('part.stl')).toBe(join(process.cwd(), 'part.stl'));
    expect(resolvePath('/a/b/../c.stl')).toBe('/a/c.stl');
  });
  test('empty paths are refused', () => {
    expect(() => resolvePath('  ')).toThrow('Give the path');
  });
  test('formats by extension, any case', () => {
    expect(formatOf('/x/A.STL')).toBe('stl');
    expect(formatOf('/x/a.3MF')).toBe('3mf');
    expect(formatOf('/x/a.obj')).toBeNull();
    expect(formatOf('/x/stl')).toBeNull();
  });
});

describe('open boundaries', () => {
  test('the demo mesh has one hole', () => {
    expect(countOpenBoundaries(demoMesh())).toBe(1);
  });
  test('two separate triangles are two open boundaries', () => {
    expect(countOpenBoundaries(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5]))).toBe(2);
  });
});
