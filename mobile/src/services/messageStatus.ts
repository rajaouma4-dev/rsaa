import {ChatMessage} from '../types';
const rank = {sent: 0, saved: 1, delivered: 2, seen: 3};
export function advanceMessageStatus(current: ChatMessage['status'], next: ChatMessage['status']): ChatMessage['status'] {
  return rank[next] > rank[current] ? next : current;
}
