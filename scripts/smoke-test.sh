#!/bin/sh
# End-to-end smoke test for D1 Drive (local dev server on :8788)
set -u
B=http://127.0.0.1:8788
PASS=0; FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1 (expected [$2] got [$3])"; fi
}

# 1. root listing
R=$(curl -s "$B/api/list?path=/")
echo "$R" | grep -q '"path":"/"' && check "list root" ok ok || check "list root" ok "bad:$R"

# 2. mkdir
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/mkdir" -H 'content-type: application/json' -d '{"path":"/photos"}')
check "mkdir /photos" 200 "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/mkdir" -H 'content-type: application/json' -d '{"path":"/docs"}')
check "mkdir /docs" 200 "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/mkdir" -H 'content-type: application/json' -d '{"path":"/docs/notes"}')
check "mkdir nested /docs/notes" 200 "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/mkdir" -H 'content-type: application/json' -d '{"path":"/nonexistent-parent/kid"}')
check "mkdir missing parent -> 409" 409 "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/mkdir" -H 'content-type: application/json' -d '{"path":"/photos"}')
check "duplicate mkdir -> 409" 409 "$C"

# 3. chunked upload of a 3 MiB random file (6 chunks @512KiB)
head -c 3145728 /dev/urandom > /tmp/test.bin
INIT=$(curl -s -X POST "$B/api/upload-init" -H 'content-type: application/json' \
  -d '{"path":"/photos/big-test.bin","size":3145728,"mime":"application/octet-stream"}')
ID=$(echo "$INIT" | sed 's/.*"id":\([0-9]*\).*/\1/')
check "upload-init returns id" 1 "$(test "$ID" != "$INIT" && echo 1 || echo 0)"

POS=0; SEQ=0
while [ $POS -lt 3145728 ]; do
  dd if=/tmp/test.bin bs=524288 skip=$((SEQ)) count=1 of=/tmp/piece.bin status=none
  C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/upload-piece?id=$ID&seq=$SEQ" --data-binary @/tmp/piece.bin)
  [ "$C" = "200" ] || { echo "piece $SEQ failed ($C)"; break; }
  POS=$((POS+524288)); SEQ=$((SEQ+1))
done
check "uploaded 6 pieces" 6 "$SEQ"

C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/upload-finish" -H 'content-type: application/json' -d "{\"id\":$ID,\"size\":3145728}")
check "upload-finish" 200 "$C"

# 4. download and verify byte-for-byte
curl -s "$B/api/download?path=%2Fphotos%2Fbig-test.bin" -o /tmp/dl.bin
if cmp -s /tmp/test.bin /tmp/dl.bin; then check "download matches original" same same; else check "download matches original" same different; fi

# 5. small file via single PUT through WebDAV
echo "hello from webdav" > /tmp/hello.txt
C=$(curl -s -o /dev/null -w "%{http_code}" -T /tmp/hello.txt "$B/dav/docs/hello.txt")
check "webdav PUT hello.txt (201)" 201 "$C"
B2=$(curl -s "$B/dav/docs/hello.txt")
check "webdav GET content roundtrip" "hello from webdav" "$B2"

# 6. PROPFIND root depth 1
P=$(curl -s -X PROPFIND -H "Depth: 1" "$B/dav/")
echo "$P" | grep -q 'multistatus' && check "PROPFIND multistatus" ok ok || check "PROPFIND multistatus" ok "no-multistatus"
echo "$P" | grep -q '/dav/photos/' && check "PROPFIND lists photos/" ok ok || check "PROPFIND lists photos/" ok missing

# 7. MKCOL via dav
C=$(curl -s -o /dev/null -w "%{http_code}" -X MKCOL "$B/dav/music")
check "MKCOL /music" 201 "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" -X MKCOL "$B/dav/music")
check "MKCOL duplicate -> 405" 405 "$C"

# 8. MOVE (rename) — target is new → 201
C=$(curl -s -o /dev/null -w "%{http_code}" -X MOVE -H "Destination: $B/dav/docs/greet.txt" "$B/dav/docs/hello.txt")
check "MOVE rename -> 201 (new)" 201 "$C"
G=$(curl -s "$B/dav/docs/greet.txt")
check "moved file readable" "hello from webdav" "$G"

# 9. COPY file into another folder
C=$(curl -s -o /dev/null -w "%{http_code}" -X COPY -H "Destination: $B/dav/photos/hello-copy.txt" "$B/dav/docs/greet.txt")
check "COPY file" 201 "$C"

# 10. COPY whole folder recursively
C=$(curl -s -o /dev/null -w "%{http_code}" -X COPY -H "Destination: $B/dav/docs-backup" "$B/dav/docs")
check "COPY folder recursive" 201 "$C"
L=$(curl -s "$B/api/list?path=/docs-backup")
echo "$L" | grep -q 'greet.txt' && check "copied folder contents" ok ok || check "copied folder contents" ok "missing:$L"

# 11. MOVE folder — new target → 201
C=$(curl -s -o /dev/null -w "%{http_code}" -X MOVE -H "Destination: $B/dav/archive" "$B/dav/docs-backup")
check "MOVE folder -> 201 (new)" 201 "$C"

# 12. DELETE folder recursive
C=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$B/dav/archive")
check "DELETE folder" 204 "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/list?path=/archive")
check "deleted folder gone" 404 "$C"

# 13. usage endpoint
U=$(curl -s "$B/api/usage")
echo "$U" | grep -q '"bytes":3145764' && check "usage bytes exact" ok ok || check "usage bytes exact" "ok" "got:$U"

# 14. overwrite via PUT (should be 204)
echo "v2 content" > /tmp/v2.txt
C=$(curl -s -o /dev/null -w "%{http_code}" -T /tmp/v2.txt "$B/dav/docs/greet.txt")
check "PUT overwrite -> 204" 204 "$C"
G=$(curl -s "$B/dav/docs/greet.txt")
check "overwritten content" "v2 content" "$G"

# 15. Overwrite:F precondition
C=$(curl -s -o /dev/null -w "%{http_code}" -X COPY -H "Destination: $B/dav/docs/greet.txt" -H "Overwrite: F" "$B/dav/photos/hello-copy.txt")
check "COPY Overwrite:F -> 412" 412 "$C"

# 16. PROPFIND depth 0
P=$(curl -s -X PROPFIND -H "Depth: 0" "$B/dav/photos/big-test.bin")
echo "$P" | grep -q '<D:getcontentlength>3145728</D:getcontentlength>' && check "PROPFIND size prop" ok ok || check "PROPFIND size prop" ok "bad"

# 17. HEAD request
H=$(curl -s -I "$B/api/download?path=%2Fphotos%2Fbig-test.bin" | tr -d '\r' | grep -i "^content-length" | awk '{print $2}')
check "HEAD content-length" 3145728 "$H"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
