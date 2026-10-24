"""Public HTTPS and compatibility checks, scoped to one unique test directory."""
import hashlib,json,time,urllib.request,urllib.error,urllib.parse,pathlib
BASE='https://drive.zhiii.top';OLD='https://www.zhiii.top';name='_drive_acceptance_'+str(time.time_ns())
checks=[]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None
opener=urllib.request.build_opener(NoRedirect)
def req(method,url,data=None,raw=None,headers=None):
    h=dict(headers or {})
    if data is not None:raw=json.dumps(data).encode();h['Content-Type']='application/json'
    try:r=opener.open(urllib.request.Request(url,data=raw,headers=h,method=method),timeout=30)
    except urllib.error.HTTPError as e:r=e
    with r:return r.status,r.read(),dict(r.headers)
assert req('GET',BASE+'/healthz')[0]==200
assert req('GET','http://drive.zhiii.top/')[0]==308
for url in [OLD+'/clouddrive',OLD+'/clouddrive/']:
    code,_,h=req('GET',url);assert code==308;assert h['Location']=='https://drive.zhiii.top/'
checks.append('HTTPS, HTTP redirect and old page redirects')
for domain in ['https://www.zhiii.top','https://zhiii.top','https://blog.zhiii.top','https://api.zhiii.top']:
    code,body,_=req('GET',domain+'/');assert code==503;assert '服务已暂停' in body.decode()
checks.append('all other business domains paused')
assert req('GET',BASE+'/_drive_internal/camera.zip')[0]==404
checks.append('internal download location inaccessible externally')
assert req('POST',OLD+'/api/clouddrive/mkdir',{'name':name})[0]==200
try:
    code,body,_=req('POST',OLD+'/api/clouddrive/upload-session',{'path':name,'name':'兼容 & ?#%.txt','size':6,'lastModified':123});assert code==201;id=json.loads(body)['id']
    assert req('PUT',OLD+f'/api/clouddrive/upload-session/{id}/chunk/0',raw=b'abcdef')[0]==200
    assert req('POST',OLD+f'/api/clouddrive/upload-session/{id}/complete')[0]==200
    url=BASE+'/api/clouddrive/download?path='+urllib.parse.quote(name+'/兼容 & ?#%.txt')
    code,body,h=req('GET',url);assert code==200 and body==b'abcdef';assert 'X-Accel-Redirect' not in h
    code,body,h=req('GET',url,headers={'Range':'bytes=1-3'});assert code==206 and body==b'bcd';assert h['Content-Range']=='bytes 1-3/6'
    code,body,h=req('GET',url,headers={'Range':'bytes=-2'});assert code==206 and body==b'ef'
    assert req('GET',url,headers={'Range':'bytes=999-1000'})[0]==416
    checks.append('old API method/body compatibility, special filename, download and Range')
finally:
    assert req('DELETE',BASE+'/api/clouddrive/remove?path='+urllib.parse.quote(name))[0]==200
result={'passed':checks};pathlib.Path(__file__).resolve().parents[1].joinpath('artifacts/public-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False,indent=2))
