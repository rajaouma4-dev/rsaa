import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {C} from '../theme';
export function Brand({small = false}: {small?: boolean}) {
  return <View style={styles.row}>
    <View style={[styles.mark, small && {width: 34, height: 34, borderRadius: 11}]}><Text style={[styles.markText, small && {fontSize: 18}]}>N</Text></View>
    <Text style={[styles.name, small && {fontSize: 17}]}>nexa<Text style={styles.chat}> chat</Text></Text>
  </View>;
}
const styles = StyleSheet.create({row: {flexDirection: 'row', alignItems: 'center', gap: 10}, mark: {width: 48, height: 48, borderRadius: 15, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center'}, markText: {fontSize: 25, fontWeight: '900', color: '#06251C'}, name: {fontSize: 23, fontWeight: '900', color: C.text, letterSpacing: -0.7}, chat: {color: C.green}});
