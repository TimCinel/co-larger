/**
 * The size-variation dial's gesture: a GestureInput (see gesture.ts for how
 * one drag, click or key press gives exactly one commit) wired to the
 * EditorStore's dial methods, which also defer costly re-assignment for
 * large collages while the dial moves.
 */
import type { FrameScheduler } from './frames';
import { GestureInput } from './gesture';
import type { EditorStore } from './store';

export type DialEditor = Pick<
  EditorStore,
  'dragVariation' | 'commitVariation' | 'isDragging'
>;

export class DialInput extends GestureInput<number> {
  constructor(
    editor: DialEditor,
    frames: Pick<FrameScheduler, 'request' | 'cancel'>,
  ) {
    super(
      {
        drag: (value) => {
          editor.dragVariation(value);
        },
        commit: (value) => {
          editor.commitVariation(value);
        },
        isDragging: () => editor.isDragging(),
      },
      frames,
      'dial',
    );
  }
}
