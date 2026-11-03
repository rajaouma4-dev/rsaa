import React,{useEffect,useState} from 'react';
import {View, Text, StyleSheet,Image} from 'react-native';
import {avatarUri,subscribeAvatar} from '../services/avatars';
import {C} from '../theme';

export function Avatar({name,uid,online=false,size=52}:{name:string;uid?:string;online?:boolean;size?:number}) {
  const [uri,setUri]=useState(avatarUri(uid));const [failed,setFailed]=useState<string|null>(null);
  useEffect(()=>{setUri(avatarUri(uid));if(uid)return subscribeAvatar(uid,()=>setUri(avatarUri(uid)));},[uid]);
  const initials = name.split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase();
  const dotSize = Math.max(11, Math.round(size * 0.28));
  return <View style={{width: size, height: size}}>
    <View style={[styles.avatar, {width: size, height: size, borderRadius: size / 2}]}>
      {uri&&failed!==uri?<Image source={{uri}} resizeMode="cover" onError={()=>setFailed(uri)} style={{width:size,height:size,borderRadius:size/2}}/>:<Text style={{color: C.text, fontSize: size * 0.33, fontWeight: '800'}}>{initials}</Text>}
    </View>
    {online ? (
      <View
        style={[
          styles.dot,
          {
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            right: 0,
            bottom: 0,
            borderWidth: 2,
            borderColor: '#18191A',
          },
        ]}
      />
    ) : null}
  </View>;
}
const styles = StyleSheet.create({
  avatar: {backgroundColor: '#263D52', alignItems: 'center', justifyContent: 'center'},
  dot: {position: 'absolute', backgroundColor: '#31A24C'},
});

