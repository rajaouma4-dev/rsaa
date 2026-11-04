import {useEffect,useState} from 'react';
import {Keyboard,NativeModules,Platform,StatusBar,useWindowDimensions} from 'react-native';
export function useKeyboardVisible(){const [visible,set]=useState(false);useEffect(()=>{const a=Keyboard.addListener('keyboardDidShow',()=>set(true));const b=Keyboard.addListener('keyboardDidHide',()=>set(false));return()=>{a.remove();b.remove();};},[]);return visible;}
export function useModalInsets(){const {width,height}=useWindowDimensions();const [value,set]=useState({top:Platform.OS==='android'?(StatusBar.currentHeight||0):44,bottom:Platform.OS==='ios'?24:0,left:0,right:0});useEffect(()=>{let active=true;void NativeModules.NexaMediaModule?.getSafeInsets?.().then((v:any)=>{if(active&&v)set(v);}).catch(()=>{});return()=>{active=false;};},[width,height]);return value;}
export function mediaWidth(width:number){return Math.max(80,Math.min(260,(width-32)*.8));}
