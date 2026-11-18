// Crazy Eights uses the shared turn-taking dealer.
import { makeDealer } from '../shared/dealer.js';
import * as engine from './engine.js';
import * as bots from './bots.js';

export const createDealer = makeDealer(engine, bots, { name: 'Crazy Eights', pace: [1100, 2000], idleMs: 30000 });
