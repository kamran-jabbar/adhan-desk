import { AppModel } from './models/AppModel.js';
import { AppView } from './views/AppView.js';
import { AppController } from './controllers/AppController.js';

// Composition root: only this file knows the Electron preload gateway.
const model = new AppModel();
const view = new AppView(document);
const controller = new AppController(window.adhan, model, view);
controller.start();
window.addEventListener('beforeunload', () => controller.dispose());
