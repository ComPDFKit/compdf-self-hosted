package licenseupdate

// These fixed scripts never interpolate filenames, credentials or license contents.
// SDK diagnostics can contain keys, so the command runner deliberately discards them.
const validateScript = `import os,sys,tempfile,subprocess,zipfile
import app
data=sys.stdin.buffer.read(65537)
fd,path=tempfile.mkstemp(suffix='.xml')
try:
 os.write(fd,data); os.close(fd)
 result=app.LibraryManager.license_verify(path,app.LICENSE_DEVICE_ID,app.LICENSE_APPID)
 if result!=app.ErrorCode.SUCCESS: sys.exit(11)
 # Validate the exact key format used by the Java engine before touching its file.
 with tempfile.TemporaryDirectory(prefix='compdf-license-check-') as directory:
  with zipfile.ZipFile('/app/pdf-processing-engine.jar') as package:
   jars=[n for n in package.namelist() if n.startswith('BOOT-INF/lib/compdfkit-core-') and n.endswith('.jar')]
   if len(jars)!=1 or package.getinfo(jars[0]).file_size>134217728: sys.exit(13)
   jar=os.path.join(directory,'core.jar')
   with open(jar,'wb') as output: output.write(package.read(jars[0]))
  source=os.path.join(directory,'LicenseCheck.java')
  with open(source,'w') as output: output.write('''import javax.xml.parsers.*;
import com.compdfkit.core.internal.NativeKMPDFKit;
class LicenseCheck {
 public static void main(String[] args) {
  try {
   DocumentBuilderFactory f=DocumentBuilderFactory.newInstance();
   f.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
   f.setAttribute("http://javax.xml.XMLConstants/property/accessExternalDTD","");
   f.setAttribute("http://javax.xml.XMLConstants/property/accessExternalSchema","");
   String key=f.newDocumentBuilder().parse(args[0]).getElementsByTagName("key").item(0).getTextContent().trim();
   NativeKMPDFKit.initialize(key,"","","compdfkit");
  } catch(Throwable error) { System.exit(12); }
 }
}''')
  check=subprocess.run(['java','-cp',jar,source,path],cwd=directory,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=40)
  sys.exit(0 if check.returncode==0 else 12)
finally:
 os.unlink(path)
`

const verifyScript = `import os,requests
headers={'Authorization':'Bearer '+os.environ.get('API_AUTH_TOKEN','')}
r=requests.get('http://127.0.0.1:7000/v1/license-type',headers=headers,timeout=10)
assert r.status_code==200 and 'licenseType' in r.json()
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>',b'<< /Length 0 >>\nstream\n\nendstream']
pdf=b'%PDF-1.4\n'; offsets=[]
for i,obj in enumerate(objects):
 offsets.append(len(pdf)); pdf+=str(i+1).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
xref=len(pdf); pdf+=b'xref\n0 5\n0000000000 65535 f \n'
for offset in offsets: pdf+=('%010d 00000 n \n'%offset).encode()
pdf+=('trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'%xref).encode()
r=requests.post('http://127.0.0.1:7001/v1/sync/optimize',data={'request':'{}'},files={'file':('license-check.pdf',pdf,'application/pdf')},headers=headers,timeout=20)
assert r.status_code==200 and r.content.startswith(b'%PDF-')
`
