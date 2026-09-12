"""Read-only, bounded HTTP sampling while the parent reloads nginx."""
import concurrent.futures,json,subprocess,time
hosts=['ampere.zwang.fun','ampere-cf.zwang.fun','baby.zwang.fun']
def check(host):
    p=subprocess.run(['curl','--silent','--head','--output','/dev/null','--write-out','%{http_code}','--max-time','5','--resolve',host+':443:127.0.0.1','https://'+host+'/'],capture_output=True,text=True)
    return dict(host=host,status=p.stdout,exitCode=p.returncode)
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for _ in range(45):
        results.append(dict(timestamp=time.time(),checks=list(pool.map(check,hosts))))
        time.sleep(1)
print(json.dumps(results,indent=2))
