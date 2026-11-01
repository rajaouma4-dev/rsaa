import {Chat, User} from '../types';

export const demoUsers: User[] = [
  {id: 'u_1024', username: 'sami.dev', name: 'Sami Rahman', online: true, about: 'Building quietly ✦'},
  {id: 'u_2048', username: 'nora_k', name: 'Nora Khan', online: true, about: 'Coffee, code, repeat.'},
  {id: 'u_3072', username: 'arif.h', name: 'Arif Hasan', online: false, about: 'Available later'},
  {id: 'u_4096', username: 'mira_s', name: 'Mira Sen', online: false, about: 'Hey there!'},
];

export const demoChats: Chat[] = [
  {id: 'c_1', user: demoUsers[0], preview: 'Sounds good, talk soon!', time: '09:41', unread: 2, messages: [
    {id: 'm1', from: 'them', text: 'Hey! Did you see the new build?', time: '09:36', status: 'seen'},
    {id: 'm2', from: 'me', text: 'Yes, checking it now.', time: '09:38', status: 'seen'},
    {id: 'm3', from: 'them', text: 'Sounds good, talk soon!', time: '09:41', status: 'delivered'},
  ]},
  {id: 'c_2', user: demoUsers[1], preview: 'Send me the details when ready.', time: 'Yesterday', unread: 0, messages: [
    {id: 'm4', from: 'them', text: 'Send me the details when ready.', time: '18:22', status: 'seen'},
  ]},
  {id: 'c_3', user: demoUsers[2], preview: 'Thanks a lot 🙌', time: 'Tue', unread: 0, messages: [
    {id: 'm5', from: 'me', text: 'Thanks a lot 🙌', time: '14:10', status: 'seen'},
  ]},
];
