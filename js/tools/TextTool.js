// js/tools/TextTool.js
import { BaseTool } from './BaseTool.js';
import { TextPrimitive } from '../cad/index.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { showPrompt } from '../ui/popup.js';

export class TextTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'text';
  }

  activate() {
    super.activate();
    this.setStatus('Text: Click to place text');
  }

  async onClick(wx, wy) {
    const text = await showPrompt({
      title: 'Add Text',
      message: 'Enter text:',
      defaultValue: 'Text',
    });
    if (text && text.trim()) {
      const heightRaw = await showPrompt({
        title: 'Add Text',
        message: 'Text height:',
        defaultValue: '5',
      });
      const height = parseFloat(heightRaw);
      const safeHeight = Number.isFinite(height) && height > 0 ? height : 5;
      takeSnapshot();
      const tp = new TextPrimitive(wx, wy, text.trim(), safeHeight);
      tp.layer = state.activeLayer;
      state.scene.texts.push(tp);
      state.emit('change');
    }
    this.setStatus('Text: Click to place text');
  }
}
