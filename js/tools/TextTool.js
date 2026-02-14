// js/tools/TextTool.js
import { BaseTool } from './BaseTool.js';
import { TextEntity } from '../entities/index.js';
import { state } from '../state.js';
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
      state.snapshot();
      const entity = new TextEntity(wx, wy, text.trim(), safeHeight);
      state.addEntity(entity);
    }
    this.setStatus('Text: Click to place text');
  }
}
