import {StyleSheet} from 'react-native';

export const C = {
  bg: '#0B1018',
  panel: '#111A26',
  panel2: '#172333',
  line: '#263548',
  text: '#F3F7FC',
  muted: '#91A1B5',
  green: '#B69EFF',
  greenDark: '#30244B',
  blue: '#79A9FF',
  red: '#FF7185',
  bubble: '#1C2B3C',
  white: '#FFFFFF',
};

export const S = StyleSheet.create({
  screen: {flex: 1, backgroundColor: C.bg},
  safe: {flex: 1, backgroundColor: C.bg},
  input: {backgroundColor: C.panel2, borderColor: C.line, borderWidth: 1, borderRadius: 14, color: C.text, paddingHorizontal: 15, paddingVertical: 14, fontSize: 15},
  primaryButton: {backgroundColor: C.green, borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center'},
  primaryText: {color: '#1C1038', fontWeight: '800', fontSize: 15},
  secondaryButton: {borderColor: C.line, borderWidth: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center'},
  secondaryText: {color: C.text, fontWeight: '700'},
});
