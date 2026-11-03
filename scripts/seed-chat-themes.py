"""Upload optimized user wallpapers to Turso; credentials stay in backend/.env."""
import os,json,base64,hashlib,io,urllib.request
from pathlib import Path
from PIL import Image,ImageOps
root=Path(__file__).resolve().parents[1]
settings={}
for line in (root/'backend/.env').read_text(encoding='utf-8').splitlines():
 if '=' in line and not line.startswith('#'):
  k,v=line.split('=',1);settings[k]=v.strip().strip('"')
url=os.environ.get('TURSO_DATABASE_URL',settings['TURSO_DATABASE_URL']).replace('libsql://','https://')+'/v2/pipeline'
token=os.environ.get('TURSO_AUTH_TOKEN',settings['TURSO_AUTH_TOKEN'])
def execute(sql,args=[]):
 body={'requests':[{'type':'execute','stmt':{'sql':sql,'args':[{'type':'text','value':v} for v in args]}},{'type':'close'}]}
 req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=30) as response: result=json.load(response)
 for item in result['results']:
  if item['type']=='error':raise RuntimeError(item['error']['message'])
 return result
execute('CREATE TABLE IF NOT EXISTS chat_theme_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, data_uri TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)')
folder=Path(os.environ.get('THEME_IMAGE_DIR',str(root.parent)))
for prefix,name in [('Topographical','Contour'),('Botanical','Botanical'),('Cat_sitting','Moon cat'),('Line_art','Mountain')]:
 files=list(folder.glob(prefix+'*.jpg'))
 if len(files)!=1:raise RuntimeError('Expected one wallpaper for '+prefix)
 img=ImageOps.exif_transpose(Image.open(files[0])).convert('RGB');img.thumbnail((720,1280))
 for quality in range(80,14,-5):
  buf=io.BytesIO();img.save(buf,format='JPEG',quality=quality,optimize=True)
  if len(buf.getvalue())<=39000:break
 raw=buf.getvalue()
 while len(raw)>39000:
  img=img.resize((int(img.width*.85),int(img.height*.85)),Image.Resampling.LANCZOS)
  buf=io.BytesIO();img.save(buf,format='JPEG',quality=65,optimize=True);raw=buf.getvalue()
 version=hashlib.sha256(raw).hexdigest();uri='data:image/jpeg;base64,'+base64.b64encode(raw).decode()
 execute('INSERT INTO chat_theme_assets(id,name,version,data_uri,enabled) VALUES(?1,?2,?3,?4,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,data_uri=excluded.data_uri,enabled=1',[prefix.lower(),name,version,uri])
 print('Uploaded',name,len(raw),'bytes')
result=execute('SELECT id,name,length(data_uri) FROM chat_theme_assets ORDER BY id')
print('Verified theme rows:',len(result['results'][0]['response']['result']['rows']))
