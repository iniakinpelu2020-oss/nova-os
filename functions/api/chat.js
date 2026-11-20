export { onRequestOptions, onRequestGet } from './council.js';
import { onRequestPost as councilPost } from './council.js';
export async function onRequestPost(context) { return councilPost(context); }