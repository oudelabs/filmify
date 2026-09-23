'use strict';
async function filmifyHostFile(blob){
 const sdk=window.xhs && window.xhs.miniTool;
 if(!sdk || typeof sdk.writeTempFile!=='function')throw new Error('当前小红书版本不支持完整图片文件保存，请更新客户端');
 const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片文件读取失败'));reader.readAsDataURL(blob);});
 const result=await sdk.writeTempFile({data:data});
 if(!result || !result.filePath)throw new Error('图片临时文件生成失败');
 return result.filePath;
}
window.filmifyCanPost=function(){const sdk=window.xhs && window.xhs.miniTool;return !!(sdk && typeof sdk.postNote==='function');};
window.filmifySavePhoto=async function(data){
  const sdk=window.xhs && window.xhs.miniTool;
  if(!sdk || typeof sdk.saveImageToPhotosAlbum!=='function')throw new Error('请在小红书小工具内保存照片');
  await sdk.saveImageToPhotosAlbum({filePath:await filmifyHostFile(data)});return '照片已保存到相册';
};
window.filmifySharePhoto=async function(data){
  if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享效果图，也可以先保存照片');
  await window.xhs.miniTool.postNote({pageType:'photo_publish',mediaInfo:{image_resources:[{url:await filmifyHostFile(data)}]}});
  return '已将效果图交给小红书';
};
window.filmifyShareLive=async function(cover,video){
  if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享实况');
  await window.xhs.miniTool.postNote({mediaInfo:{live_photo_resources:[{url:await filmifyHostFile(cover),video_url:await filmifyHostFile(video)}]}});
  return '已将实况素材交给小红书';
};
// postNote documents data URI image resources (1–18), not temporary local paths.
function filmifyPhotoPost(mediaInfo,note){
 const options={pageType:'photo_publish',mediaInfo:mediaInfo};
 if(note){options.content=note.content;options.tags=note.tags;}
 return options;
}
window.filmifySharePhotos=async function(blobs,note){
 if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享，浏览器中可以先保存照片');
 if(!blobs.length||blobs.length>18)throw new Error('分享需要 1–18 张图片');
 const resources=[];
 for(const blob of blobs){
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('分享图片读取失败'));reader.readAsDataURL(blob);});
  resources.push({url:data});
 }
 await window.xhs.miniTool.postNote(filmifyPhotoPost({image_resources:resources},note));
};
function filmifyShareDataURI(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('分享素材读取失败'));reader.readAsDataURL(blob);});}
// Mixed single-photo share group: stills (对比图/效果图) + one 4s development live photo
// in the same note. mediaInfo allows image_resources + live_photo_resources together.
window.filmifyShareLiveGroup=async function(stillBlobs,coverBlob,videoBlob,note){
 if(!window.filmifyCanPost())throw new Error('请在小红书小工具内分享，浏览器中可以先保存照片');
 if(!stillBlobs.length||stillBlobs.length>17)throw new Error('分享需要 1–17 张图片加 1 张实况');
 const resources=[];
 for(const blob of stillBlobs)resources.push({url:await filmifyShareDataURI(blob)});
 const live={url:await filmifyShareDataURI(coverBlob),video_url:await filmifyShareDataURI(videoBlob)};
 await window.xhs.miniTool.postNote(filmifyPhotoPost({image_resources:resources,live_photo_resources:[live]},note));
};
