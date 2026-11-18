// Rummy uses the shared turn-taking dealer.
import { makeDealer } from '../shared/dealer.js';
import * as engine from './engine.js';
import * as bots from './bots.js';

export const createDealer = makeDealer(engine, bots, { name: 'Rummy', pace: [1000, 1800], idleMs: 45000 });
