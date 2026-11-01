import React from 'react';
import {View, Text, Pressable, StyleSheet} from 'react-native';
import {SDUIComponent} from './schema';
import {C} from '../theme';

export function SDUIRenderer({components, onAction}: {components: SDUIComponent[]; onAction: (action: 'open_profile' | 'open_chats' | 'open_people') => void}) {
  return <View style={styles.root}>{components.map(component => renderComponent(component, onAction))}</View>;
}

function renderComponent(component: SDUIComponent, onAction: (action: 'open_profile' | 'open_chats' | 'open_people') => void): React.ReactNode {
  switch (component.type) {
    case 'text':
      return <Text key={component.id} style={component.role === 'title' ? styles.title : component.role === 'caption' ? styles.caption : styles.body}>{component.value}</Text>;
    case 'button':
      return <Pressable key={component.id} onPress={() => onAction(component.action)} style={styles.button}><Text style={styles.buttonText}>{component.label}</Text></Pressable>;
    case 'card':
      return <View key={component.id} style={styles.card}>{component.children.map(child => renderComponent(child, onAction))}</View>;
    default:
      return null;
  }
}
const styles = StyleSheet.create({root: {gap: 8}, card: {backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 16, padding: 14, gap: 8}, title: {color: C.text, fontSize: 18, fontWeight: '900'}, body: {color: C.text, fontSize: 13}, caption: {color: C.muted, fontSize: 10}, button: {backgroundColor: C.greenDark, borderRadius: 11, padding: 12}, buttonText: {color: C.green, fontWeight: '800', fontSize: 12}});
