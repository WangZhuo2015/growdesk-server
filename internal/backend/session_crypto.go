package backend

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// Session secrets and lost-response replay payloads are encrypted, not logged.
// The domain string separates BFF credentials from refresh replay ciphertext.
func(s *Server)sessionCipher()(cipher.AEAD,error){key:=sha256.Sum256([]byte("growdesk/session/v1/"+s.Config.SessionEncryptionKey));block,err:=aes.NewCipher(key[:]);if err!=nil{return nil,err};return cipher.NewGCM(block)}
func(s *Server)sealSession(value,domain string)(string,error){gcm,err:=s.sessionCipher();if err!=nil{return "",err};nonce:=make([]byte,gcm.NonceSize());if _,err=rand.Read(nonce);err!=nil{return "",err};ciphertext:=gcm.Seal(nonce,nonce,[]byte(value),[]byte(domain));return "go:v1:"+base64.RawURLEncoding.EncodeToString(ciphertext),nil}
func(s *Server)openSession(value,domain string)(string,error){
	if !strings.HasPrefix(value,"go:v1:"){return "",errors.New("invalid encrypted session value")}
	raw,err:=base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value,"go:v1:"));if err!=nil{return "",errors.New("invalid encrypted session value")};gcm,err:=s.sessionCipher();if err!=nil{return "",err};if len(raw)<gcm.NonceSize(){return "",errors.New("invalid encrypted session value")};plain,err:=gcm.Open(nil,raw[:gcm.NonceSize()],raw[gcm.NonceSize():],[]byte(domain));if err!=nil{return "",errors.New("session encryption key mismatch")};return string(plain),nil
}
