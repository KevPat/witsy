
import { Application, Automator as AutomatorImpl } from 'types/automation';
import { clipboard } from 'electron';
import MacosAutomator from './macos'
import WindowsAutomator from './windows'
import NutAutomator from './nut'
import Automation from './automation';
import { ClipboardSnapshot, restoreClipboard, saveClipboard } from './clipboard_snapshot';

export default class Automator {
  
  automator: AutomatorImpl;

  constructor() {
    if (process.platform === 'darwin') {
      this.automator = new MacosAutomator();
    } else if (process.platform === 'win32') {
      this.automator = new WindowsAutomator();
    } else {
      this.automator = new NutAutomator();
    }
  }

  async getForemostApp(): Promise<Application|null> {
    try {
      return await this.automator.getForemostApp();
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  async selectAll(): Promise<void> {
    try {
      await this.automator.selectAll();
    } catch (error) {
      console.error(error);
    }
  }

  async moveCaretBelow(): Promise<void> {
    try {
      await this.automator.moveCaretBelow();
    } catch (error) {
      console.error(error);
    }
  }

  async getSelectedText(): Promise<string> {

    // what the user had on the clipboard (text, image...) is put back whatever happens
    let snapshot: ClipboardSnapshot|null = null;

    try {

      // save and set
      snapshot = saveClipboard();
      clipboard.writeText('');

      // get it
      await this.automator.copySelectedText();
      return clipboard.readText();

    } catch (error) {
      console.error(error);
      return null;
    } finally {
      if (snapshot) {
        restoreClipboard(snapshot);
      }
    }

  }

  async deleteSelectedText(): Promise<void> {
    try {
      await this.automator.deleteSelectedText();
    } catch (error) {
      console.error(error);
    }
  }

  async pasteClipboard(): Promise<void> {
    try {
      await this.automator.pasteText();
    } catch (error) {
      console.error(error);
    } 
  }

  async pasteText(textToPaste: string): Promise<boolean> {

    // what the user had on the clipboard (text, image...) is put back whatever happens
    let snapshot: ClipboardSnapshot|null = null;

    try {

      // save and set
      snapshot = saveClipboard();

      // try to write text to clipboard
      const copied = await Automation.writeTextToClipboard(textToPaste);
      if (!copied) {
        return false;
      }

      // paste it
      await this.pasteClipboard();
      return true;

    } catch (error) {
      console.error(error);
      return false;
    } finally {
      if (snapshot) {
        restoreClipboard(snapshot);
      }
    }

  }

}