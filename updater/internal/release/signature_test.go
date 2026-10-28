package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestVerifySignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := []byte(`{"schemaVersion":1}`)
	digest := sha256.Sum256(manifest)
	signature := Signature{
		SchemaVersion:  1,
		Algorithm:      "Ed25519",
		KeyID:          "release-test",
		ManifestSHA256: hex.EncodeToString(digest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest)),
	}

	if err := VerifySignature(manifest, signature, map[string]ed25519.PublicKey{"release-test": publicKey}); err != nil {
		t.Fatalf("VerifySignature() error = %v", err)
	}
	manifest[0] = '['
	if err := VerifySignature(manifest, signature, map[string]ed25519.PublicKey{"release-test": publicKey}); err == nil {
		t.Fatal("tampered manifest passed verification")
	}
}

func TestParseSignatureRejectsUnknownFields(t *testing.T) {
	data := []byte(`{"schemaVersion":1,"algorithm":"Ed25519","keyId":"test","manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==","command":"docker rm"}`)
	if _, err := ParseSignature(data); err == nil {
		t.Fatal("signature with unknown command field was accepted")
	}
}
