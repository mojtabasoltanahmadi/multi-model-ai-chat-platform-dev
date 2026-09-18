import { BadRequestException } from '@nestjs/common';
import { File, FileStatus, canTransition } from './file.entity';

function makeFile(status: FileStatus): File {
  const file = new File();
  file.status = status;
  return file;
}

describe('file status state machine', () => {
  const legal: [FileStatus, FileStatus][] = [
    ['UPLOADING', 'PROCESSING'],
    ['PROCESSING', 'READY'],
    ['PROCESSING', 'FAILED'],
    ['READY', 'PROCESSING'], // explicit reprocess only
    ['FAILED', 'PROCESSING'], // explicit reprocess only
  ];

  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    const file = makeFile(from);
    file.assertTransition(to);
    expect(file.status).toBe(to);
  });

  const illegal: [FileStatus, FileStatus][] = [
    ['UPLOADING', 'READY'],
    ['UPLOADING', 'FAILED'],
    ['UPLOADING', 'UPLOADING'],
    ['PROCESSING', 'UPLOADING'],
    ['PROCESSING', 'PROCESSING'],
    ['READY', 'READY'],
    ['READY', 'FAILED'],
    ['FAILED', 'READY'],
    ['FAILED', 'FAILED'],
  ];

  it.each(illegal)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    const file = makeFile(from);
    expect(() => file.assertTransition(to)).toThrow(BadRequestException);
    // The illegal transition must not mutate the entity.
    expect(file.status).toBe(from);
  });

  it('never lets a READY file move to FAILED or RE-UPLOAD implicitly', () => {
    const file = makeFile('READY');
    expect(() => file.assertTransition('FAILED')).toThrow();
    expect(() => file.assertTransition('UPLOADING')).toThrow();
    expect(file.status).toBe('READY');
  });
});
