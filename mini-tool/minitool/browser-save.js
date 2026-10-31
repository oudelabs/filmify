'use strict';
// Local browser adapter; deliberately excluded from the Xiaohongshu ZIP.
(function(){
 const nativeSave=window.filmifySavePhoto;
 window.filmifyBrowserMode=function(){return !(window.xhs&&window.xhs.miniTool);};
 function download(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.appendChild(a);
  try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 }
 window.filmifySavePhoto=async function(blob,name,guard){
  if(guard)guard();
  if(!window.filmifyBrowserMode())return nativeSave(blob,name,guard);
  if(!blob||blob.type.indexOf('image/')!==0)throw new Error('请选择图片保存');
  download(blob,'filmify-'+name+(blob.type==='image/png'?'.png':'.jpg'));
  return '已发起照片下载，请在浏览器下载中查看';
 };
})();
