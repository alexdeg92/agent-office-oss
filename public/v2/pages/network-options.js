import { msg } from '../i18n.js';
import { registerMessages } from '../messages.js';
import * as dictionary from '../messages/network.js';

registerMessages(dictionary);
export const NETWORK_MODES = ['local', 'lan', 'tailnet', 'public', 'tunnel'];
// Translate on render so Setup and Settings share options through language changes.
export const networkOptions = () => NETWORK_MODES.map(value => ({value,label:msg('network.mode.' + value)}));
