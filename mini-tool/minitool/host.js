'use strict';
function filmifyHostWait(promise,guard,message,deadline){
 return new Promise((resolve,reject)=>{
  let done=false,timer=0,poll=0;
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);clearInterval(poll);error?reject(error):resolve(value);}
  function check(){if(done)return false;try{if(guard)guard();return true;}catch(error){finish(error);return false;}}
  if(deadline!==false)timer=setTimeout(()=>finish(new Error(message)),30000);
  if(guard)poll=setInterval(check,25);
  promise.then(value=>{if(check())finish(null,value);},error=>finish(error));
 });
}
function filmifyDataURI(blob,guard){
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();let done=false,timer=0,poll=0;
  function finish(error){
   if(done)return;done=true;clearTimeout(timer);clearInterval(poll);reader.onload=reader.onerror=reader.onabort=null;
   if(error){if(reader.readyState===1)reader.abort();reject(error);}else resolve(reader.result);
  }
  function check(){if(done)return false;try{if(guard)guard();return true;}catch(error){finish(error);return false;}}
  if(!check())return;
  timer=setTimeout(()=>finish(new Error('素材文件读取超时，请重试')),30000);
  if(guard)poll=setInterval(check,25);
  reader.onload=()=>{if(check())finish();};reader.onerror=()=>finish(new Error('素材文件读取失败'));reader.onabort=()=>finish(new Error('素材文件读取已取消'));
  try{reader.readAsDataURL(blob);}catch(error){finish(error);}
 });
}
async function filmifyHostFile(blob,guard){
 if(guard)guard();
 const sdk=window.xhs && window.xhs.miniTool;
 if(!sdk || typeof sdk.writeTempFile!=='function')throw new Error('当前小红书版本不支持临时素材文件，请更新客户端');
 const data=await filmifyDataURI(blob,guard);
 if(guard)guard();
 const result=await filmifyHostWait(sdk.writeTempFile({data:data}),guard,'临时素材写入超时，请重试');
 if(guard)guard();
 if(!result || typeof result.filePath!=='string' || !result.filePath)throw new Error('临时素材文件生成失败');
 return result.filePath;
}
window.filmifyCanPost=function(){const sdk=window.xhs && window.xhs.miniTool;return !!(sdk && typeof sdk.postNote==='function');};
window.filmifySavePhoto=async function(data,name,guard){
  if(guard)guard();
  if(data&&data.type&&data.type.indexOf('image/')!==0)throw new Error('此接口仅支持保存图片，不能保存视频或实况');
  const sdk=window.xhs && window.xhs.miniTool;
  if(!sdk || typeof sdk.saveImageToPhotosAlbum!=='function')throw new Error('请在小红书小工具内保存照片');
  const filePath=await filmifyHostFile(data,guard);
  if(guard)guard();
  await filmifyHostWait(sdk.saveImageToPhotosAlbum({filePath:filePath}),guard,'相册保存超时，请检查相册后重试');
  if(guard)guard();
  return '照片已保存到相册';
};
window.filmifySharePhoto=async function(data){
  if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享效果图，也可以先保存照片');
  await window.xhs.miniTool.postNote({pageType:'photo_publish',mediaInfo:{image_resources:[{url:await filmifyHostFile(data)}]}});
  return '已将效果图交给小红书';
};
window.filmifyShareLive=async function(cover,video){
  if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享实况');
  await window.xhs.miniTool.postNote({pageType:'photo_publish',mediaInfo:{live_photo_resources:[{url:await filmifyDataURI(cover),video_url:await filmifyDataURI(video)}]}});
  return '已将实况素材交给小红书';
};
// Still-image file handles work in the host and limit Base64 retained for large batches.
function filmifyPhotoPost(mediaInfo,note){
 const options={pageType:'photo_publish',mediaInfo:mediaInfo};
 if(note){options.content=note.content;options.tags=note.tags;}
 return options;
}
window.filmifySharePhotos=async function(blobs,note,guard){
 if(guard)guard();
 if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享，浏览器中可以先保存照片');
 if(!blobs.length||blobs.length>18)throw new Error('分享需要 1–18 张图片');
 const resources=[];
 for(const blob of blobs){
  resources.push({url:await filmifyHostFile(blob,guard)});
 }
 if(guard)guard(true);
 // The documented completion may wait for the user to publish in the native
 // editor. Cancel the app's wait when obsolete, without timing out that editor.
 await filmifyHostWait(window.xhs.miniTool.postNote(filmifyPhotoPost({image_resources:resources},note)),guard,'',false);
};
// Mixed share group: one 4s development live photo + stills (对比图/效果图).
// iOS 9.48 device probe G accepts live_photo_resources + photo_publish + data URIs.
// Keep the verified video bytes; native-file playback does not prove live-photo handoff.
window.filmifyShareLiveGroup=async function(stillBlobs,coverBlob,videoBlob,note,guard){
 if(guard)guard();
 if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享，浏览器中可以先保存照片');
 if(!stillBlobs.length||stillBlobs.length>17)throw new Error('分享需要 1–17 张图片加 1 张实况');
 const resources=[];
 for(const blob of stillBlobs)resources.push({url:await filmifyHostFile(blob,guard)});
 if(guard)guard();
 const cover=await filmifyDataURI(coverBlob,guard);
 if(guard)guard();
 const video=await filmifyDataURI(videoBlob,guard);
 const live={url:cover,video_url:video};
 // Match probe G's live-first payload; native cross-array display order is undocumented.
 if(guard)guard(true);
 await filmifyHostWait(window.xhs.miniTool.postNote(filmifyPhotoPost({live_photo_resources:[live],image_resources:resources},note)),guard,'',false);
};

// The native container can restrict blob: media. Decode its returned file handle unchanged.
window.filmifyVideoSource=async function(blob){
 const sdk=window.xhs&&window.xhs.miniTool;
 if(sdk){
  const filePath=await filmifyHostFile(blob);
  return {url:filePath,filePath:filePath,kind:'native-file',release:function(){}};
 }
 const url=URL.createObjectURL(blob);
 return {url:url,kind:'blob',release:function(){URL.revokeObjectURL(url);}};
};
